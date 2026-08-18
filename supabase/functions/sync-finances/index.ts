// sync-finances — zieht Amazon-Gebühren aus der SP-API Finances API
// (listFinancialEvents) und schreibt sie monatlich nach finance_monatlich.
// Aufruf wie die anderen Sync-Functions: POST { tenant_id, tage? } mit
// service_role-Bearer (verify_jwt = true). Standard-Fenster: 90 Tage.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  akkuZuZeilen, detailZuZeilen, monatSchreibbar,
  verarbeiteFinancialEvents, verarbeiteGebuehrenDetail,
} from "../_shared/finances.ts";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";
const MAX_SEITEN = 80; // Sicherheitskappe gegen Endlos-Pagination
const PAUSE_MS = 1500; // listFinancialEvents: ~0,5 req/s -> defensiv 1,5s je Seite

Deno.serve(async (req) => {
  try {
    const { tenant_id, tage } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);
    const fenster = Number(tage) > 0 ? Number(tage) : 90;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: ctx, error: ctxErr } = await supabase.from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret")
      .eq("tenant_id", tenant_id).eq("source", "sp").single();
    if (ctxErr || !ctx) return json({ error: "auth_context nicht gefunden", detail: ctxErr?.message }, 404);

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) return json({ error: "Vault-Werte fehlen" }, 500);

    const accessToken = await holeAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    const postedAfter = new Date(Date.now() - fenster * 86400000).toISOString();
    const akku = new Map<string, number>();       // Monatssumme (wie bisher)
    const detailAkku = new Map<string, number>(); // Monat × SKU × Gebührenart
    let nextToken: string | undefined;
    let seiten = 0;

    do {
      const url = new URL(`${SP_ENDPOINT}/finances/v0/financialEvents`);
      if (nextToken) {
        url.searchParams.set("NextToken", nextToken);
      } else {
        url.searchParams.set("PostedAfter", postedAfter);
        url.searchParams.set("MaxResultsPerPage", "100");
      }

      const resp = await fetch(url.toString(), { headers: { "x-amz-access-token": accessToken } });
      if (resp.status === 429) { // Rate-Limit: einmal warten und weiter
        await schlaf(PAUSE_MS * 3);
        continue;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // Diagnose: gleicher Token gegen einen rollenfreien Endpoint. Sellers 200 +
        // Finances 403 = Token gültig, nur die Finance-Rolle fehlt in der Autorisierung.
        let sellersStatus = 0;
        try {
          const s = await fetch(`${SP_ENDPOINT}/sellers/v1/marketplaceParticipations`, {
            headers: { "x-amz-access-token": accessToken },
          });
          sellersStatus = s.status;
        } catch { /* egal */ }
        return json({
          error: "Finances API Fehler",
          status: resp.status,
          detail: data,
          token_check_sellers_status: sellersStatus,
          diagnose: sellersStatus === 200
            ? "Token gültig (Sellers 200) — es fehlt NUR die Finance-Rolle in der Autorisierung."
            : `Sellers-Endpoint antwortete ${sellersStatus} — Token/Autorisierung prüfen.`,
        }, 502);
      }

      verarbeiteFinancialEvents(data?.payload?.FinancialEvents, akku);
      // Dieselben Events zusaetzlich je SKU/Gebuehrenart — Grundlage fuer den
      // Nettogewinn JE PRODUKT (die Monatssumme allein reicht dafuer nicht).
      verarbeiteGebuehrenDetail(data?.payload?.FinancialEvents, detailAkku);
      nextToken = data?.payload?.NextToken || undefined;
      seiten++;
      if (nextToken && seiten < MAX_SEITEN) await schlaf(PAUSE_MS);
    } while (nextToken && seiten < MAX_SEITEN);

    const abgeschnitten = seiten >= MAX_SEITEN && Boolean(nextToken);

    // NUR VOLLSTAENDIG GESEHENE MONATE SCHREIBEN.
    //
    // Der Upsert ERSETZT den Wert eines Monats. Ein Monat, den dieser Lauf nur
    // angeschnitten hat, wuerde damit einen korrekten Wert durch einen Teilwert
    // ersetzen. Genau so ging am 18.8.2026 der Juni verloren (1.063 statt 16.584
    // Euro), und beim Reparaturversuch derselben Sache der Mai.
    //
    // Zwei Faelle, in denen ein Monat angeschnitten ist:
    //
    //   1. Der Fensteranfang liegt mitten im Monat -> diesem Monat fehlt der
    //      Anfang. Betrifft immer genau einen Monat, den aeltesten.
    //   2. Der Lauf brach bei MAX_SEITEN ab -> welche Monate unvollstaendig
    //      sind, ist NICHT bestimmbar (die Reihenfolge der Seiten ist nicht
    //      zugesichert). Dann wird gar nichts geschrieben. Lieber keine neuen
    //      Daten als kaputte: der naechste Lauf holt es nach.
    //
    // Der LAUFENDE Monat wird geschrieben, obwohl er naturgemaess unvollstaendig
    // ist — er ist so vollstaendig, wie er sein kann, und ohne ihn gaebe es fuer
    // den aktuellen Monat nie Zahlen. Die Anzeige weist ihn gesondert aus.
    const vollstaendig = (monat: string) => monatSchreibbar(monat, postedAfter, abgeschnitten);

    const zeilen = akkuZuZeilen(akku).filter((z) => vollstaendig(z.monat));
    if (zeilen.length > 0) {
      const { error: upErr } = await supabase.from("finance_monatlich").upsert(
        zeilen.map((z) => ({ tenant_id, monat: z.monat, gebuehren_cents: z.gebuehren_cents, updated_at: new Date().toISOString() })),
        { onConflict: "tenant_id,monat" },
      );
      if (upErr) return json({ error: "Upsert fehlgeschlagen", detail: upErr.message }, 500);
    }

    // Detailzeilen je Monat/SKU/Gebuehrenart. sku=null -> '' (ohne Artikelbezug).
    const detailZeilen = detailZuZeilen(detailAkku).filter((d) => vollstaendig(d.monat));
    if (detailZeilen.length > 0) {
      const jetzt = new Date().toISOString();
      const BATCH = 500;
      for (let i = 0; i < detailZeilen.length; i += BATCH) {
        const { error: dErr } = await supabase.from("finance_gebuehren").upsert(
          detailZeilen.slice(i, i + BATCH).map((d) => ({
            tenant_id, monat: d.monat, sku: d.sku ?? "", fee_typ: d.fee_typ,
            betrag_cents: d.betrag_cents, updated_at: jetzt,
          })),
          { onConflict: "tenant_id,monat,sku,fee_typ" },
        );
        if (dErr) return json({ error: "Gebuehren-Detail-Upsert fehlgeschlagen", detail: dErr.message }, 500);
      }
    }

    // Was NICHT geschrieben wurde, muss in der Antwort stehen — sonst ist das
    // Auslassen genauso still wie vorher das Ueberschreiben.
    const gesehen = akkuZuZeilen(akku).map((z) => z.monat);
    const uebersprungen = gesehen.filter((m) => !vollstaendig(m));

    return json({
      ok: true,
      seiten,
      abgeschnitten,
      monate: zeilen.length,
      gebuehren_detailzeilen: detailZeilen.length,
      gebuehren_gesamt_cents: zeilen.reduce((s, z) => s + z.gebuehren_cents, 0),
      uebersprungene_monate: uebersprungen,
      hinweis: abgeschnitten
        ? `Abbruch nach ${MAX_SEITEN} Seiten — NICHTS geschrieben, weil nicht bestimmbar ist, welche Monate vollstaendig sind. Mit kleinerem 'tage' erneut versuchen.`
        : uebersprungen.length > 0
        ? `Monat(e) ${uebersprungen.join(", ")} liegen nur teilweise im Fenster und wurden bewusst nicht geschrieben — ein Teilwert wuerde den korrekten ersetzen.`
        : undefined,
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

async function holeAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
  });
  const resp = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  return resp.ok ? (data.access_token ?? null) : null;
}

async function readSecret(supabase: any, secretId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_secret_id: secretId });
  if (error || !data) return null;
  return data as string;
}

function schlaf(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// sync-finances — zieht Amazon-Gebühren aus der SP-API Finances API
// (listFinancialEvents) und schreibt sie monatlich nach finance_monatlich.
// Aufruf wie die anderen Sync-Functions: POST { tenant_id, tage? } mit
// service_role-Bearer (verify_jwt = true). Standard-Fenster: 90 Tage.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { akkuZuZeilen, verarbeiteFinancialEvents } from "../_shared/finances.ts";

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
    const akku = new Map<string, number>();
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
      nextToken = data?.payload?.NextToken || undefined;
      seiten++;
      if (nextToken && seiten < MAX_SEITEN) await schlaf(PAUSE_MS);
    } while (nextToken && seiten < MAX_SEITEN);

    const zeilen = akkuZuZeilen(akku);
    if (zeilen.length > 0) {
      const { error: upErr } = await supabase.from("finance_monatlich").upsert(
        zeilen.map((z) => ({ tenant_id, monat: z.monat, gebuehren_cents: z.gebuehren_cents, updated_at: new Date().toISOString() })),
        { onConflict: "tenant_id,monat" },
      );
      if (upErr) return json({ error: "Upsert fehlgeschlagen", detail: upErr.message }, 500);
    }

    return json({
      ok: true,
      seiten,
      abgeschnitten: seiten >= MAX_SEITEN && Boolean(nextToken),
      monate: zeilen.length,
      gebuehren_gesamt_cents: zeilen.reduce((s, z) => s + z.gebuehren_cents, 0),
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

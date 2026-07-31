// sync-katalog — holt die EINGETRAGENEN Katalogmaße über die Catalog Items API.
//
// Warum eine eigene Function: Kein Report liefert die Katalogmaße. Der
// Gebührenvorschau-Report enthält nur, was Amazon GEMESSEN hat. Erst beides
// zusammen ergibt den Soll-Ist-Abgleich (Fee Decoder Modul 3).
//
// Aufruf wie die anderen Sync-Functions: POST { tenant_id } mit
// service_role-Bearer (verify_jwt = true).
//
// searchCatalogItems nimmt bis zu 20 ASINs je Aufruf. Rate-Limit laut Amazon
// 2 req/s (Burst 2) — hier defensiv 1 Aufruf/Sekunde.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { baueKatalogMass } from "../_shared/katalog.ts";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";
const ASINS_JE_AUFRUF = 20;
const PAUSE_MS = 1000;
const MAX_AUFRUFE = 50; // Kappe: 1.000 ASINs je Lauf

const LAND: Record<string, string> = {
  A1PA6795UKMFR9: "DE", A13V1IB3VIYZZH: "FR", APJ6JRA9NG5V4: "IT",
  A1RKKUPIHCS9HS: "ES", A1F83G8C2ARO7P: "UK", A1805IZSGTT6HS: "NL",
  A2NODRKZP88ZB9: "SE", A1C3SOZRARQ6R3: "PL", AMEN7PMS3EDWL: "BE",
  A28R8C7NBKEWEA: "IE",
};

Deno.serve(async (req) => {
  try {
    const { tenant_id } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: ctx, error: ctxErr } = await supabase.from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, marketplace_id")
      .eq("tenant_id", tenant_id).eq("source", "sp").single();
    if (ctxErr || !ctx) return json({ error: "auth_context nicht gefunden", detail: ctxErr?.message }, 404);

    const marketplaceId = String(ctx.marketplace_id ?? "");
    const marketplace = LAND[marketplaceId];
    if (!marketplace) return json({ error: "Marktplatz unbekannt", detail: marketplaceId }, 400);

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) return json({ error: "Vault-Werte fehlen" }, 500);

    const accessToken = await holeAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    // Nur ASINs, für die es überhaupt etwas abzugleichen gibt: die aus der
    // Gebührenvorschau. Alles andere wäre Aufrufe ohne Gegenstück.
    const { data: asinRows } = await supabase.from("fba_gebuehrenvorschau")
      .select("asin").eq("tenant_id", tenant_id).eq("marketplace", marketplace)
      .not("asin", "is", null);
    const asins = [...new Set(((asinRows ?? []) as any[]).map((r) => String(r.asin)))];
    if (asins.length === 0) {
      return json({
        ok: true, asins: 0, geschrieben: 0,
        hinweis: "Keine ASINs aus der Gebührenvorschau — erst diesen Report ziehen.",
      });
    }

    const zeilen: any[] = [];
    const fehler: string[] = [];
    let aufrufe = 0;

    for (let i = 0; i < asins.length && aufrufe < MAX_AUFRUFE; i += ASINS_JE_AUFRUF) {
      const paket = asins.slice(i, i + ASINS_JE_AUFRUF);
      const url = new URL(`${SP_ENDPOINT}/catalog/2022-04-01/items`);
      url.searchParams.set("identifiers", paket.join(","));
      url.searchParams.set("identifiersType", "ASIN");
      url.searchParams.set("marketplaceIds", marketplaceId);
      url.searchParams.set("includedData", "dimensions,summaries");

      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { "x-amz-access-token": accessToken },
      });
      aufrufe++;
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // Nicht abbrechen: ein fehlgeschlagenes Paket soll die anderen nicht
        // mitreissen. Der Fehler wird gemeldet, nicht verschluckt.
        fehler.push(`HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
        if (resp.status === 403 || resp.status === 401) break; // Rolle fehlt -> weitere Aufrufe zwecklos
        await schlaf(PAUSE_MS);
        continue;
      }

      for (const item of (data?.items ?? [])) {
        const k = baueKatalogMass(item, marketplaceId, marketplace);
        if (!k) continue;
        zeilen.push({
          tenant_id, asin: k.asin, marketplace: k.marketplace,
          laenge_cm: k.laenge_cm, breite_cm: k.breite_cm, hoehe_cm: k.hoehe_cm,
          gewicht_g: k.gewicht_g,
          produkt_laenge_cm: k.produkt_laenge_cm, produkt_breite_cm: k.produkt_breite_cm,
          produkt_hoehe_cm: k.produkt_hoehe_cm, produkt_gewicht_g: k.produkt_gewicht_g,
          marke: k.marke, stand: new Date().toISOString(), raw: k.raw,
        });
      }
      await schlaf(PAUSE_MS);
    }

    let geschrieben = 0;
    if (zeilen.length > 0) {
      const { error } = await supabase.from("katalog_masse")
        .upsert(zeilen, { onConflict: "tenant_id,asin,marketplace" });
      if (error) return json({ error: "Speichern fehlgeschlagen", detail: error.message }, 500);
      geschrieben = zeilen.length;
    }

    const mitMassen = zeilen.filter((z) => z.laenge_cm !== null && z.breite_cm !== null && z.hoehe_cm !== null).length;
    return json({
      ok: true, marketplace, asins: asins.length, aufrufe,
      geschrieben, mit_vollstaendigen_massen: mitMassen,
      ohne_masse: geschrieben - mitMassen,
      ...(fehler.length ? { fehler } : {}),
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

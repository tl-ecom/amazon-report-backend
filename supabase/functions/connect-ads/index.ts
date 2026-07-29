// connect-ads — Erst-Connect der Amazon **Advertising API** (getrennt von SP-API).
//
// Analog connect-sp, aber gegen die Ads-API:
//   1. LWA-Tausch refresh_token -> access_token (der Token trägt den Ads-Scope).
//   2. GET /v2/profiles -> Werbe-Profile; das zum Marktplatz passende automatisch
//      wählen (profile_id). Kein manuelles Raten.
//   3. Secrets in den Vault + auth_contexts (source='ads', profile_id) — nur bei
//      Erfolg. Danach Auto-Sync (sync_ads_jetzt).
//
// Auth: Supabase-SESSION-JWT. NUR Plattform-Admin (Coach) darf verbinden — wie SP.
// Secrets werden nie geloggt/zurückgegeben.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { istPlattformAdmin } from "../_shared/admin.ts";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// EU-Advertising-Endpoint (deckt DE/UK/FR/IT/ES/NL/BE ab).
const ADS_ENDPOINT = "https://advertising-api-eu.amazon.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) return json({ error: "Nicht angemeldet" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Ungültige Session" }, 401);

    const { data: myTenant } = await userClient.rpc("my_tenant_id");
    const service = createClient(SUPABASE_URL, SERVICE_KEY);

    // Nur der Coach (Plattform-Admin) darf Ads verbinden.
    if (!(await istPlattformAdmin(service, userData.user.id))) {
      return json({ error: "Nur der Coach darf die Ads-Verbindung verwalten." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const clientId = str(body.client_id);
    const clientSecret = str(body.client_secret);
    const refreshToken = str(body.refresh_token);
    const marketplaceId = str(body.marketplace_id);
    const region = str(body.region) || "eu";
    const companyId = str(body.company_id);

    // Zieltenant: eigener oder (als Admin) gewählte Firma.
    let tenantId: string | null = (myTenant as string) ?? null;
    if (companyId) {
      const { data: firma } = await service.from("tenants").select("id").eq("id", companyId).maybeSingle();
      if (!firma) return json({ error: "Firma nicht gefunden." }, 404);
      tenantId = companyId;
    }
    if (!tenantId) return json({ error: "Kein Tenant zugeordnet" }, 403);

    const fehlend = [
      !clientId && "client_id", !clientSecret && "client_secret",
      !refreshToken && "refresh_token", !marketplaceId && "marketplace_id",
    ].filter(Boolean);
    if (fehlend.length) return json({ error: "Pflichtfelder fehlen", felder: fehlend }, 400);

    // --- 1) LWA-Tausch (validiert Credentials + Ads-Scope) ---
    const lwa = await tauscheToken(clientId!, clientSecret!, refreshToken!);
    if (!lwa.ok) {
      return json({
        error: "Amazon lehnt die Zugangsdaten ab",
        detail: lwa.detail,
        hinweis: "client_id/secret/refresh_token prüfen. Der Refresh-Token muss den Advertising-Scope tragen. Es wurde NICHTS gespeichert.",
      }, 400);
    }

    // --- 2) Profile abrufen, passendes zum Marktplatz wählen ---
    const prof = await ladeProfile(clientId!, lwa.accessToken!);
    if (!prof.ok) return json({ error: "Ads-Profile konnten nicht geladen werden", detail: prof.detail }, 502);
    const treffer = prof.profile.find((p) => p?.accountInfo?.marketplaceStringId === marketplaceId);
    if (!treffer) {
      return json({
        error: "Kein Werbe-Profil für diesen Marktplatz",
        hinweis: "Der autorisierte Ads-Account hat kein Profil für diesen Marktplatz.",
        verfuegbar: prof.profile.map((p) => ({ profileId: p.profileId, land: p.countryCode, marketplace: p?.accountInfo?.marketplaceStringId })),
      }, 404);
    }
    const profileId = String(treffer.profileId);

    // --- 3) Secrets in den Vault (eigene ads_-Namen, getrennt von SP) ---
    const cidId = await upsertSecret(service, `ads_client_id_${tenantId}`, clientId!);
    const csecId = await upsertSecret(service, `ads_client_secret_${tenantId}`, clientSecret!);
    const rtId = await upsertSecret(service, `ads_refresh_token_${tenantId}`, refreshToken!);
    if (!cidId || !csecId || !rtId) return json({ error: "Vault-Schreiben fehlgeschlagen" }, 500);

    const { error: upErr } = await service.from("auth_contexts").upsert({
      tenant_id: tenantId,
      source: "ads",
      region,
      marketplace_id: marketplaceId,
      profile_id: profileId,
      client_id_secret: cidId,
      client_secret_secret: csecId,
      refresh_token_secret: rtId,
      status: "connected",
      connected_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,source" });
    if (upErr) return json({ error: "auth_context speichern fehlgeschlagen", detail: upErr.message }, 500);

    // --- 4) Auto-Sync anstoßen (best-effort) ---
    try { await service.rpc("sync_ads_jetzt", { p_tenant: tenantId }); } catch (_) { /* nicht blockierend */ }

    return json({
      ok: true,
      status: "connected",
      tenant_id: tenantId,
      marketplace_id: marketplaceId,
      profile_id: profileId,
      land: treffer.countryCode ?? null,
      hinweis: "Ads verbunden. Der Sponsored-Products-Report wird gezogen; Kennzahlen im Ads-Tab / get_ads_overview.",
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

async function tauscheToken(clientId: string, clientSecret: string, refreshToken: string):
  Promise<{ ok: true; accessToken: string } | { ok: false; detail: unknown }> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  const resp = await fetch(LWA_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: body.toString() });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !(data as any).access_token) {
    return { ok: false, detail: { error: (data as any).error, error_description: (data as any).error_description } };
  }
  return { ok: true, accessToken: (data as any).access_token };
}

async function ladeProfile(clientId: string, accessToken: string):
  Promise<{ ok: true; profile: any[] } | { ok: false; detail: unknown }> {
  const resp = await fetch(`${ADS_ENDPOINT}/v2/profiles`, {
    method: "GET",
    headers: { "Amazon-Advertising-API-ClientId": clientId, "Authorization": `Bearer ${accessToken}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, detail: data };
  return { ok: true, profile: Array.isArray(data) ? data : [] };
}

async function upsertSecret(service: any, name: string, value: string): Promise<string | null> {
  const { data, error } = await service.rpc("upsert_vault_secret", { p_name: name, p_secret: value });
  if (error || !data) return null;
  return data as string;
}

function str(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t === "" ? null : t;
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// connect-sp — Erst-Connect eines Sellers per SP-API (Self-Auth / "Weg A").
//
// KEIN OAuth-Code-Tausch: Der Seller hat in SEINER eigenen self-authorized App
// (Seller Central) bereits einen Refresh-Token erzeugt. Er reicht hier client_id,
// client_secret und refresh_token ein; diese Function prüft sie live bei Amazon
// und legt sie — nur bei Erfolg — verschlüsselt im Vault + auth_contexts ab.
//
// Auth: Supabase-SESSION-JWT (verify_jwt=true). Der Tenant kommt aus der Identität
// (my_tenant_id über auth.uid()), NIE aus dem Request-Body — nicht fälschbar.
// Analog zum api-Endpunkt.
//
// Operator-Ansatz: erst validieren, dann speichern. Ungültige Credentials werden
// NICHT abgelegt (ehrliches Scheitern statt eines toten auth_contexts). Secrets
// werden nie geloggt und nie zurückgegeben.

import { createClient } from "jsr:@supabase/supabase-js@2";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Frontend ruft von einer anderen Origin (Portal/Lovable).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  try {
    // --- Auth: eingeloggter Nutzer → Tenant ---
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ error: "Nicht angemeldet" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Ungültige Session" }, 401);

    const { data: tenantId, error: tErr } = await userClient.rpc("my_tenant_id");
    if (tErr) return json({ error: "Tenant-Auflösung fehlgeschlagen", detail: tErr.message }, 500);
    if (!tenantId) {
      return json({
        error: "Kein Tenant zugeordnet",
        hinweis: "Dieser Nutzer ist keinem Tenant zugewiesen (tenant_members).",
      }, 403);
    }

    // --- Eingaben ---
    const body = await req.json().catch(() => ({}));
    const clientId = str(body.client_id);
    const clientSecret = str(body.client_secret);
    const refreshToken = str(body.refresh_token);
    const marketplaceId = str(body.marketplace_id);
    const region = str(body.region) || "eu";

    const fehlend = [
      !clientId && "client_id",
      !clientSecret && "client_secret",
      !refreshToken && "refresh_token",
      !marketplaceId && "marketplace_id",
    ].filter(Boolean);
    if (fehlend.length) {
      return json({ error: "Pflichtfelder fehlen", felder: fehlend }, 400);
    }

    // --- 1) Live-Validierung bei Amazon (VOR dem Speichern) ---
    // Der Refresh-Token-Tausch validiert alle drei Werte auf einmal. Schlägt er
    // fehl, sind die Credentials unbrauchbar → nichts wird gespeichert.
    const lwa = await tauscheToken(clientId!, clientSecret!, refreshToken!);
    if (!lwa.ok) {
      return json({
        error: "Amazon lehnt die Zugangsdaten ab",
        // error/error_description von Amazon (z.B. "invalid_grant") — kein Secret.
        detail: lwa.detail,
        hinweis: "client_id, client_secret und refresh_token prüfen. Es wurde NICHTS gespeichert.",
      }, 400);
    }

    // --- 2) Secrets in den Vault (nur bei Erfolg), deterministische Namen ---
    const service = createClient(SUPABASE_URL, SERVICE_KEY);
    const cidId = await upsertSecret(service, `sp_client_id_${tenantId}`, clientId!);
    const csecId = await upsertSecret(service, `sp_client_secret_${tenantId}`, clientSecret!);
    const rtId = await upsertSecret(service, `sp_refresh_token_${tenantId}`, refreshToken!);
    if (!cidId || !csecId || !rtId) {
      return json({ error: "Vault-Schreiben fehlgeschlagen" }, 500);
    }

    // --- 3) auth_contexts upserten (source 'sp', status 'connected') ---
    // service_role umgeht RLS → tenant_id ist die aufgelöste, nicht aus dem Body.
    const { error: upErr } = await service
      .from("auth_contexts")
      .upsert(
        {
          tenant_id: tenantId,
          source: "sp",
          region,
          marketplace_id: marketplaceId,
          client_id_secret: cidId,
          client_secret_secret: csecId,
          refresh_token_secret: rtId,
          status: "connected",
          connected_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,source" }
      );
    if (upErr) {
      return json({ error: "auth_context speichern fehlgeschlagen", detail: upErr.message }, 500);
    }

    // --- 4) Antwort — KEINE Secrets ---
    return json({
      ok: true,
      status: "connected",
      tenant_id: tenantId,
      marketplace_id: marketplaceId,
      region,
      access_token_laenge: lwa.accessTokenLen,
      expires_in: lwa.expiresIn,
      hinweis: "SP-API verbunden. Reports können jetzt über sync-report gezogen werden.",
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

/** Tauscht einen Refresh-Token gegen einen Access-Token (validiert die Credentials). */
async function tauscheToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ ok: true; accessTokenLen: number; expiresIn: number } | { ok: false; detail: unknown }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Nur die nicht-sensiblen Fehlerfelder weitergeben.
    return { ok: false, detail: { error: (data as any).error, error_description: (data as any).error_description } };
  }
  return {
    ok: true,
    accessTokenLen: ((data as any).access_token ?? "").length,
    expiresIn: (data as any).expires_in,
  };
}

async function upsertSecret(service: any, name: string, value: string): Promise<string | null> {
  const { data, error } = await service.rpc("upsert_vault_secret", { p_name: name, p_secret: value });
  if (error || !data) return null;
  return data as string;
}

/** Trimmt und liefert null bei leer — verhindert, dass Leerstrings als gültig gelten. */
function str(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t === "" ? null : t;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

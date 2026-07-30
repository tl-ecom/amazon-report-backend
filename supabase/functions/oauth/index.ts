// oauth — MCP-OAuth-2.1-Authorization-Server (Self-Serve-Connect).
//
// WICHTIG (Supabase-Eigenheit): Auf der geteilten *.supabase.co-Domain erzwingt
// Supabase Content-Type text/plain für HTML (Phishing-Schutz) — eine gerenderte
// Login-Seite ist dort NICHT möglich. Deshalb liefert diese Function nur JSON +
// Redirects; die Login-/Zustimmungs-Oberfläche rendert das Pulse-Frontend.
//
// Ablauf:
//   Discovery/DCR  wie gehabt (JSON).
//   GET /authorize -> 302 auf das Frontend (…/?oauth_connect=1&<params>). Dort
//                     loggt sich der Nutzer ein und bestätigt.
//   POST /confirm  -> vom Frontend, mit Supabase-Session-JWT (Bearer). Prüft
//                     Client/redirect_uri/PKCE, löst den Tenant aus der IDENTITÄT
//                     (Teilnehmer: eigene Firma; Coach: gewählte), stellt den
//                     Auth-Code aus und gibt die Redirect-URL zurück.
//   POST /token    -> Code -> Access/Refresh (PKCE-geprüft) bzw. Refresh-Rotation.
//
// verify_jwt = false: OAuth-Clients bringen keinen Supabase-JWT mit; /confirm
// prüft das Session-JWT selbst.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  baueAsMetadata, baueResourceMetadata, oauthBasis, pkceStimmt, pruefeAuthorizeParams,
  pruefeRedirectUris, redirectMitCode, sha256Hex, zufallsToken,
} from "../_shared/oauth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 86400 * 1000;

const SB_URL = () => Deno.env.get("SUPABASE_URL")!;
const ANON = () => Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FRONTEND = () => (Deno.env.get("FRONTEND_URL") ?? "https://pulse.amz-connect.de").replace(/\/+$/, "");
const service = () => createClient(SB_URL(), SERVICE());

interface Params {
  response_type: string; client_id: string; redirect_uri: string;
  scope: string; state: string; code_challenge: string; code_challenge_method: string; resource: string;
}
function paramsAus(get: (k: string) => unknown): Params {
  const s = (k: string) => String(get(k) ?? "");
  return {
    response_type: s("response_type"), client_id: s("client_id"), redirect_uri: s("redirect_uri"),
    scope: s("scope"), state: s("state"), code_challenge: s("code_challenge"),
    code_challenge_method: s("code_challenge_method"), resource: s("resource"),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const path = new URL(req.url).pathname;
  const { issuer, resource } = oauthBasis();

  if (req.method === "GET" && path.endsWith("/.well-known/oauth-authorization-server")) return json(baueAsMetadata(issuer));
  if (req.method === "GET" && path.endsWith("/.well-known/oauth-protected-resource")) return json(baueResourceMetadata(resource, issuer));
  if (req.method === "POST" && path.endsWith("/register")) return dcrRegister(req);
  if (path.endsWith("/authorize")) {
    return req.method === "GET" ? authorizeGet(req) : json({ error: "invalid_request", error_description: "GET erwartet" }, 405);
  }
  if (path.endsWith("/confirm")) {
    return req.method === "POST" ? confirmPost(req) : json({ error: "invalid_request", error_description: "POST erwartet" }, 405);
  }
  if (path.endsWith("/token")) {
    return req.method === "POST" ? tokenPost(req) : json({ error: "invalid_request", error_description: "POST erforderlich" }, 405);
  }
  return json({ error: "not_found" }, 404);
});

// --- Dynamic Client Registration (RFC 7591) ---
async function dcrRegister(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "Body ist kein JSON" }, 400);
  }
  let uris: string[];
  try {
    uris = pruefeRedirectUris(body?.redirect_uris);
  } catch (e) {
    return json({ error: "invalid_redirect_uri", error_description: String((e as Error)?.message ?? e) }, 400);
  }
  const client_id = crypto.randomUUID();
  const client_name = String(body?.client_name ?? "MCP Client").slice(0, 120);
  const { error } = await service().from("oauth_clients").insert({
    client_id, client_name, redirect_uris: uris, token_endpoint_auth_method: "none",
  });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  return json({
    client_id, client_name, redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
}

// --- /authorize: validieren, dann auf die Frontend-Zustimmung leiten ---
async function authorizeGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = paramsAus((k) => url.searchParams.get(k));

  const client = await ladeClient(p.client_id);
  if (!client) return redirectFrontend({ oauth_error: "Unbekannter Client. Bitte den Connector neu einrichten." });
  if (!redirectErlaubt(client, p.redirect_uri)) return redirectFrontend({ oauth_error: "redirect_uri ist für diesen Client nicht registriert." });
  const pr = pruefeAuthorizeParams(p);
  if (!pr.ok) return redirectFrontend({ oauth_error: pr.fehler });

  return redirectFrontend(p as unknown as Record<string, string>);
}

// --- /confirm: vom Frontend mit Session-JWT -> Auth-Code + Redirect-URL ---
async function confirmPost(req: Request): Promise<Response> {
  const authz = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+/i.test(authz)) return json({ error: "login_required", error_description: "Anmeldung erforderlich" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_request", error_description: "JSON erwartet" }, 400);
  }
  const p = paramsAus((k) => body?.[k]);

  const client = await ladeClient(p.client_id);
  if (!client) return json({ error: "invalid_client", error_description: "Unbekannter Client" }, 400);
  if (!redirectErlaubt(client, p.redirect_uri)) return json({ error: "invalid_request", error_description: "redirect_uri nicht registriert" }, 400);
  const pr = pruefeAuthorizeParams(p);
  if (!pr.ok) return json({ error: "invalid_request", error_description: pr.fehler }, 400);

  // Nutzer aus dem Session-JWT.
  const anon = createClient(SB_URL(), ANON(), { global: { headers: { Authorization: authz } } });
  const { data: u } = await anon.auth.getUser();
  if (!u?.user) return json({ error: "login_required", error_description: "Sitzung ungültig — bitte erneut anmelden" }, 401);
  const userId = u.user.id;

  // Tenant aus der Identität: Coach wählt Firma, Teilnehmer bekommt die eigene.
  let tenantId: string;
  const { data: admin } = await service().from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (admin) {
    const company = String(body?.company_id ?? "");
    const tenants = await ladeTenants();
    if (!company || !tenants.some((t) => t.id === company)) {
      return json({ need_company: true, tenants }, 200); // Frontend zeigt die Firmen-Auswahl
    }
    tenantId = company;
  } else {
    const { data: m } = await service().from("tenant_members").select("tenant_id").eq("user_id", userId).limit(1).maybeSingle();
    if (!m?.tenant_id) return json({ error: "access_denied", error_description: "Dein Konto ist noch keiner Firma zugeordnet." }, 403);
    tenantId = m.tenant_id as string;
  }

  const code = zufallsToken(32);
  const code_hash = await sha256Hex(code);
  const { error } = await service().from("oauth_auth_codes").insert({
    code_hash, client_id: p.client_id, redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge, code_challenge_method: p.code_challenge_method,
    user_id: userId, tenant_id: tenantId, scope: p.scope || "mcp", resource: p.resource || null,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), used: false,
  });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  return json({ redirect: redirectMitCode(p.redirect_uri, code, p.state || null) });
}

// --- /token: Code einlösen bzw. Refresh (RFC 6749 + PKCE RFC 7636) ---
async function tokenPost(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return oauthErr("invalid_request", "Body muss application/x-www-form-urlencoded sein");
  }
  const grant = String(form.get("grant_type") ?? "");
  if (grant === "authorization_code") return codeGegenToken(form);
  if (grant === "refresh_token") return refreshGrant(form);
  return oauthErr("unsupported_grant_type", `grant_type '${grant}' nicht unterstützt`);
}

async function codeGegenToken(form: FormData): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const client_id = String(form.get("client_id") ?? "");
  const redirect_uri = String(form.get("redirect_uri") ?? "");
  if (!code || !verifier || !client_id) return oauthErr("invalid_request", "code, code_verifier, client_id erforderlich");

  const code_hash = await sha256Hex(code);
  const db = service();
  const { data: row } = await db.from("oauth_auth_codes").select("*").eq("code_hash", code_hash).maybeSingle();
  if (!row) return oauthErr("invalid_grant", "Code unbekannt");
  if (row.used) return oauthErr("invalid_grant", "Code bereits eingelöst");
  if (new Date(row.expires_at).getTime() < Date.now()) return oauthErr("invalid_grant", "Code abgelaufen");
  if (row.client_id !== client_id) return oauthErr("invalid_grant", "client_id passt nicht zum Code");
  if (redirect_uri && row.redirect_uri !== redirect_uri) return oauthErr("invalid_grant", "redirect_uri passt nicht");
  if (!(await pkceStimmt(verifier, row.code_challenge))) return oauthErr("invalid_grant", "PKCE-Verifier falsch");

  await db.from("oauth_auth_codes").update({ used: true }).eq("code_hash", code_hash);
  return tokenAusstellen(row.client_id, row.user_id, row.tenant_id, row.scope);
}

async function refreshGrant(form: FormData): Promise<Response> {
  const refresh = String(form.get("refresh_token") ?? "");
  const client_id = String(form.get("client_id") ?? "");
  if (!refresh) return oauthErr("invalid_request", "refresh_token erforderlich");

  const refresh_hash = await sha256Hex(refresh);
  const db = service();
  const { data: row } = await db.from("oauth_tokens").select("*").eq("refresh_hash", refresh_hash).eq("revoked", false).maybeSingle();
  if (!row) return oauthErr("invalid_grant", "Refresh-Token unbekannt oder widerrufen");
  if (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() < Date.now()) return oauthErr("invalid_grant", "Refresh-Token abgelaufen");
  if (client_id && row.client_id !== client_id) return oauthErr("invalid_grant", "client_id passt nicht");

  const access = zufallsToken(32);
  const neuRefresh = zufallsToken(32);
  const now = Date.now();
  const { error } = await db.from("oauth_tokens").update({
    access_hash: await sha256Hex(access),
    refresh_hash: await sha256Hex(neuRefresh),
    access_expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
    last_used_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (error) return oauthErr("server_error", error.message, 500);
  return tokenAntwort(access, neuRefresh, row.scope);
}

async function tokenAusstellen(client_id: string, user_id: string, tenant_id: string, scope: string | null): Promise<Response> {
  const access = zufallsToken(32);
  const refresh = zufallsToken(32);
  const now = Date.now();
  const { error } = await service().from("oauth_tokens").insert({
    access_hash: await sha256Hex(access),
    refresh_hash: await sha256Hex(refresh),
    client_id, user_id, tenant_id, scope: scope || "mcp",
    access_expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
    revoked: false,
  });
  if (error) return oauthErr("server_error", error.message, 500);
  return tokenAntwort(access, refresh, scope);
}

function tokenAntwort(access: string, refresh: string, scope: string | null): Response {
  return json({ access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: scope || "mcp" });
}

// --- Helfer ---
async function ladeClient(client_id: string): Promise<{ client_id: string; redirect_uris: unknown } | null> {
  if (!client_id) return null;
  const { data } = await service().from("oauth_clients").select("client_id, redirect_uris").eq("client_id", client_id).maybeSingle();
  return data ?? null;
}
function redirectErlaubt(client: { redirect_uris: unknown }, redirect_uri: string): boolean {
  const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  return Boolean(redirect_uri) && uris.includes(redirect_uri);
}
async function ladeTenants(): Promise<Array<{ id: string; name: string }>> {
  const { data } = await service().from("tenants").select("id, name").order("name");
  return (data ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name ?? t.id) }));
}
function redirectFrontend(params: Record<string, string>): Response {
  const u = new URL(FRONTEND() + "/");
  u.searchParams.set("oauth_connect", "1");
  for (const [k, v] of Object.entries(params)) {
    if (k === "oauth_connect" || v == null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return new Response(null, { status: 302, headers: { Location: u.toString(), "Cache-Control": "no-store", ...CORS } });
}

function oauthErr(error: string, error_description: string, status = 400): Response {
  return json({ error, error_description }, status);
}
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
}

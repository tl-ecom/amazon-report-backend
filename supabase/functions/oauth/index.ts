// oauth — MCP-OAuth-2.1-Authorization-Server (Self-Serve-Connect).
//
// Schritt 1: Discovery + Dynamic Client Registration.
// Schritt 2 (NEU): /authorize — Login (Supabase) + Zustimmung + PKCE-Auth-Code.
//   GET  …/oauth/authorize  -> Login-Seite (HTML), trägt die OAuth-Parameter mit.
//   POST …/oauth/authorize  -> E-Mail/Passwort prüfen; Teilnehmer -> eigene Firma
//        automatisch, Coach/Admin -> Firma wählen (signiertes Ticket, kein
//        erneutes Passwort); dann Auth-Code (nur Hash gespeichert) + 302 zurück.
// /token folgt in Schritt 3 (hier noch 501).
//
// verify_jwt = false: OAuth-Clients bringen keinen Supabase-JWT mit.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  baueAsMetadata, baueResourceMetadata, escHtml, oauthBasis, pkceStimmt, pruefeAuthorizeParams,
  pruefeRedirectUris, pruefeTicket, redirectMitCode, sha256Hex, signeTicket, zufallsToken,
} from "../_shared/oauth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CODE_TTL_MS = 5 * 60 * 1000;      // Auth-Code 5 Min gültig
const TICKET_TTL_MS = 10 * 60 * 1000;   // Coach-Login-Ticket 10 Min gültig
const ACCESS_TTL_MS = 60 * 60 * 1000;   // Access-Token 1 Std
const REFRESH_TTL_MS = 30 * 86400 * 1000; // Refresh-Token 30 Tage

const SB_URL = () => Deno.env.get("SUPABASE_URL")!;
const ANON = () => Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const service = () => createClient(SB_URL(), SERVICE());

// OAuth-Parameter, die durch den Flow getragen werden.
interface Params {
  response_type: string; client_id: string; redirect_uri: string;
  scope: string; state: string; code_challenge: string; code_challenge_method: string; resource: string;
}
function paramsAus(get: (k: string) => string | null): Params {
  return {
    response_type: get("response_type") ?? "",
    client_id: get("client_id") ?? "",
    redirect_uri: get("redirect_uri") ?? "",
    scope: get("scope") ?? "",
    state: get("state") ?? "",
    code_challenge: get("code_challenge") ?? "",
    code_challenge_method: get("code_challenge_method") ?? "",
    resource: get("resource") ?? "",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const path = new URL(req.url).pathname;
  const { issuer, resource } = oauthBasis();

  if (req.method === "GET" && path.endsWith("/.well-known/oauth-authorization-server")) {
    return json(baueAsMetadata(issuer));
  }
  if (req.method === "GET" && path.endsWith("/.well-known/oauth-protected-resource")) {
    return json(baueResourceMetadata(resource, issuer));
  }
  if (req.method === "POST" && path.endsWith("/register")) return dcrRegister(req);
  if (path.endsWith("/authorize")) {
    return req.method === "GET" ? authorizeGet(req, issuer) : authorizePost(req, issuer);
  }
  if (path.endsWith("/token")) {
    return req.method === "POST" ? tokenPost(req) : json({ error: "invalid_request", error_description: "POST erforderlich" }, 405);
  }
  return json({ error: "not_found" }, 404);
});

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

  // Single-Use: Code sofort verbrauchen.
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

  // Access UND Refresh rotieren (Best Practice).
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
  return json({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: scope || "mcp",
  });
}

function oauthErr(error: string, error_description: string, status = 400): Response {
  return json({ error, error_description }, status);
}

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

// --- /authorize GET: Login-Seite anzeigen ---
async function authorizeGet(req: Request, issuer: string): Promise<Response> {
  const url = new URL(req.url);
  const p = paramsAus((k) => url.searchParams.get(k));

  const client = await ladeClient(p.client_id);
  if (!client) return htmlFehler("Unbekannter Client. Bitte den Connector neu einrichten.");
  if (!redirectErlaubt(client, p.redirect_uri)) return htmlFehler("redirect_uri ist für diesen Client nicht registriert.");

  const pr = pruefeAuthorizeParams(p);
  if (!pr.ok) return htmlFehler(pr.fehler);

  return html(loginSeite(issuer, p, null));
}

// --- /authorize POST: Login prüfen -> (Coach: Firma wählen) -> Auth-Code ---
async function authorizePost(req: Request, issuer: string): Promise<Response> {
  const form = await req.formData();
  const p = paramsAus((k) => (form.get(k) as string) ?? null);

  const client = await ladeClient(p.client_id);
  if (!client) return htmlFehler("Unbekannter Client.");
  if (!redirectErlaubt(client, p.redirect_uri)) return htmlFehler("redirect_uri nicht registriert.");
  const pr = pruefeAuthorizeParams(p);
  if (!pr.ok) return htmlFehler(pr.fehler);

  const ticket = (form.get("ticket") as string) ?? "";

  // Zweiter Schritt (Coach): Ticket + Firmenwahl, kein Passwort mehr.
  if (ticket) {
    const userId = await pruefeTicket(SERVICE(), ticket, Date.now());
    if (!userId) return html(loginSeite(issuer, p, "Sitzung abgelaufen — bitte erneut anmelden."));
    const company = (form.get("company_id") as string) ?? "";
    const tenants = await ladeTenants();
    if (!company || !tenants.some((t) => t.id === company)) {
      return html(consentSeite(issuer, p, ticket, tenants, "Bitte eine Firma wählen."));
    }
    return await codeAusstellen(issuer, p, userId, company);
  }

  // Erster Schritt: E-Mail + Passwort.
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return html(loginSeite(issuer, p, "E-Mail und Passwort eingeben."));

  const anon = createClient(SB_URL(), ANON());
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data?.user) return html(loginSeite(issuer, p, "Login fehlgeschlagen — E-Mail/Passwort prüfen."));
  const userId = data.user.id;

  // Coach/Admin? -> Firma wählen (Ticket, damit kein erneutes Passwort nötig ist).
  const { data: admin } = await service().from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (admin) {
    const tenants = await ladeTenants();
    if (tenants.length === 0) return htmlFehler("Es ist keine Firma angelegt.");
    const t = await signeTicket(SERVICE(), userId, Date.now() + TICKET_TTL_MS);
    return html(consentSeite(issuer, p, t, tenants, null));
  }

  // Teilnehmer: eigene Firma automatisch.
  const { data: m } = await service().from("tenant_members").select("tenant_id").eq("user_id", userId).limit(1).maybeSingle();
  if (!m?.tenant_id) return htmlFehler("Dein Konto ist noch keiner Firma zugeordnet oder nicht freigegeben.");
  return await codeAusstellen(issuer, p, userId, m.tenant_id as string);
}

async function codeAusstellen(_issuer: string, p: Params, userId: string, tenantId: string): Promise<Response> {
  const code = zufallsToken(32);
  const code_hash = await sha256Hex(code);
  const { error } = await service().from("oauth_auth_codes").insert({
    code_hash, client_id: p.client_id, redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge, code_challenge_method: p.code_challenge_method,
    user_id: userId, tenant_id: tenantId, scope: p.scope || "mcp", resource: p.resource || null,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), used: false,
  });
  if (error) return htmlFehler(`Konnte Code nicht ausstellen: ${error.message}`);
  const ziel = redirectMitCode(p.redirect_uri, code, p.state || null);
  return new Response(null, { status: 302, headers: { Location: ziel, "Cache-Control": "no-store" } });
}

// --- DB-Helfer ---
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

// --- HTML ---
function hiddenFelder(p: Params): string {
  return (Object.keys(p) as (keyof Params)[])
    .map((k) => `<input type="hidden" name="${k}" value="${escHtml(p[k])}">`).join("");
}
function seite(titel: string, inner: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(titel)}</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f17;color:#e8edf5}
  .card{width:100%;max-width:400px;margin:24px;padding:28px;border-radius:14px;background:#131a26;
    border:1px solid #263041;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 4px} .sub{font-size:13px;color:#93a1b8;margin:0 0 20px}
  label{display:block;font-size:12px;color:#93a1b8;margin:14px 0 6px}
  input,select{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2c3547;
    background:#0d131d;color:#e8edf5;font-size:14px}
  button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:9px;font-size:14px;font-weight:600;
    color:#fff;background:linear-gradient(90deg,#6d5efc,#c04bff);cursor:pointer}
  .err{margin-top:14px;padding:10px 12px;border-radius:9px;background:#3a1720;color:#ff9db0;font-size:13px}
  .foot{margin-top:18px;font-size:11px;color:#6b7688;line-height:1.5}
</style></head><body><div class="card">${inner}</div></body></html>`;
}
function loginSeite(issuer: string, p: Params, fehler: string | null): string {
  return seite("Operator Pulse — Verbinden", `
    <h1>Operator Pulse verbinden</h1>
    <p class="sub">Melde dich an, um deiner KI (ChatGPT/Claude) Lesezugriff auf deine Pulse-Daten zu geben.</p>
    <form method="post" action="${escHtml(issuer)}/authorize">
      ${hiddenFelder(p)}
      <label>E-Mail</label>
      <input type="email" name="email" autocomplete="username" required autofocus>
      <label>Passwort</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">Anmelden &amp; verbinden</button>
    </form>
    ${fehler ? `<div class="err">${escHtml(fehler)}</div>` : ""}
    <p class="foot">Die KI bekommt ausschließlich <b>Lesezugriff</b>. Kein Schreiben, keine Kontoänderungen. Zugriff jederzeit widerrufbar.</p>`);
}
function consentSeite(issuer: string, p: Params, ticket: string, tenants: Array<{ id: string; name: string }>, fehler: string | null): string {
  const opts = tenants.map((t) => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join("");
  return seite("Operator Pulse — Firma wählen", `
    <h1>Firma wählen</h1>
    <p class="sub">Als Coach angemeldet. Für welche Firma soll der KI-Zugang gelten?</p>
    <form method="post" action="${escHtml(issuer)}/authorize">
      ${hiddenFelder(p)}
      <input type="hidden" name="ticket" value="${escHtml(ticket)}">
      <label>Firma</label>
      <select name="company_id" required>${opts}</select>
      <button type="submit">Zugang erteilen</button>
    </form>
    ${fehler ? `<div class="err">${escHtml(fehler)}</div>` : ""}
    <p class="foot">Der Zugang ist an diese Firma gebunden und nur lesend.</p>`);
}
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
}
function htmlFehler(msg: string): Response {
  return html(seite("Fehler", `<h1>Verbindung nicht möglich</h1><div class="err">${escHtml(msg)}</div>`), 400);
}
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
}

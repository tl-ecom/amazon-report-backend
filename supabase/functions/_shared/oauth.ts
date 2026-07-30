// oauth.ts — gemeinsame Bausteine für den MCP-OAuth-2.1-Server.
// Reine Builder/Validatoren (unit-getestet) + die konfigurierbaren Basis-URLs.
//
// Basis-URLs sind per ENV überschreibbar (OAUTH_ISSUER / MCP_RESOURCE_URL), damit
// wir denselben Code hinter der Supabase-Funktions-URL ODER später hinter einer
// eigenen Domain (Root-.well-known) betreiben können — ohne Code-Änderung.

/** Issuer (= OAuth-AS-Basis) und geschützte Ressource (= MCP-Server-URL). */
export function oauthBasis(): { issuer: string; resource: string } {
  const sb = Deno.env.get("SUPABASE_URL") ?? "";
  const issuer = (Deno.env.get("OAUTH_ISSUER") ?? `${sb}/functions/v1/oauth`).replace(/\/+$/, "");
  const resource = (Deno.env.get("MCP_RESOURCE_URL") ?? `${sb}/functions/v1/mcp`).replace(/\/+$/, "");
  return { issuer, resource };
}

/** URL der Protected-Resource-Metadaten (fürs WWW-Authenticate-Header von mcp). */
export function ressourcenMetadatenUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource`;
}

/** Authorization-Server-Metadaten (RFC 8414). */
export function baueAsMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

/** Protected-Resource-Metadaten (RFC 9728). */
export function baueResourceMetadata(resource: string, issuer: string): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  };
}

/**
 * Prüft die redirect_uris einer Client-Registrierung. Erlaubt HTTPS überall und
 * HTTP nur für localhost/127.0.0.1 (lokale MCP-Clients). Gibt die bereinigte
 * Liste zurück oder wirft mit aussagekräftiger Meldung.
 */
export function pruefeRedirectUris(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : [];
  const uris = arr.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (uris.length === 0) throw new Error("redirect_uris erforderlich (nicht-leeres Array)");
  for (const u of uris) {
    let p: URL;
    try {
      p = new URL(u);
    } catch {
      throw new Error(`ungültige redirect_uri: ${u}`);
    }
    const lokal = p.hostname === "localhost" || p.hostname === "127.0.0.1";
    if (p.protocol !== "https:" && !(p.protocol === "http:" && lokal)) {
      throw new Error(`redirect_uri muss HTTPS sein (Ausnahme localhost): ${u}`);
    }
  }
  return uris;
}

/** SHA-256-Hex — für Codes/Tokens (DB sieht nie den Klartext). */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Base64url ohne Padding aus Bytes. */
export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE-Challenge (S256) aus einem code_verifier. */
export async function pkceS256(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(buf));
}

/** Prüft PKCE: S256(code_verifier) == gespeicherte code_challenge. */
export async function pkceStimmt(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || !challenge) return false;
  return (await pkceS256(verifier)) === challenge;
}

/** Kryptografisch zufälliges URL-sicheres Token (Base64url ohne Padding). */
export function zufallsToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Protokoll-Prüfung der /authorize-Parameter (PKCE-Pflicht, nur S256). Rein. */
export function pruefeAuthorizeParams(
  p: { response_type?: string | null; code_challenge?: string | null; code_challenge_method?: string | null },
): { ok: true } | { ok: false; fehler: string } {
  if (p.response_type !== "code") return { ok: false, fehler: "response_type muss 'code' sein" };
  if (!p.code_challenge) return { ok: false, fehler: "code_challenge fehlt (PKCE ist Pflicht)" };
  if (p.code_challenge_method !== "S256") return { ok: false, fehler: "code_challenge_method muss S256 sein" };
  return { ok: true };
}

/** Baut die Redirect-URL zurück zum Client mit code (+ state). */
export function redirectMitCode(redirectUri: string, code: string, state?: string | null): string {
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

/** HTML-Attribut/Text-Escaping für in Seiten eingebettete Parameter. */
export function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Signiertes Kurzticket „User X ist angemeldet" (HMAC-SHA256 mit Server-Secret) —
 * damit der Coach nach dem Login die Firma wählen kann, OHNE das Passwort erneut
 * einzugeben. Format: `<userId>.<expMs>.<sigHex>`.
 */
export async function signeTicket(secret: string, userId: string, expMs: number): Promise<string> {
  const payload = `${userId}.${expMs}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${sigHex}`;
}

/** Prüft ein Ticket; gibt die userId zurück oder null (ungültig/abgelaufen). */
export async function pruefeTicket(secret: string, ticket: string, jetztMs: number): Promise<string | null> {
  const i1 = ticket.indexOf(".");
  const i2 = ticket.indexOf(".", i1 + 1);
  if (i1 < 0 || i2 < 0) return null;
  const userId = ticket.slice(0, i1);
  const exp = Number(ticket.slice(i1 + 1, i2));
  if (!Number.isFinite(exp) || exp < jetztMs) return null;
  const erwartet = await signeTicket(secret, userId, exp);
  return erwartet === ticket ? userId : null;
}

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

/** Kryptografisch zufälliges URL-sicheres Token (Base64url ohne Padding). */
export function zufallsToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

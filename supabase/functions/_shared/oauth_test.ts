import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  baueAsMetadata, baueResourceMetadata, escHtml, mcpPfadRest, mcpRessource, pkceS256, pkceStimmt,
  pruefeAuthorizeParams, pruefeRedirectUris, pruefeTicket, redirectMitCode, ressourcenMetadatenUrl,
  ressourcenMetadatenUrlFuer, signeTicket,
} from "./oauth.ts";

Deno.test("AS-Metadaten: Endpunkte relativ zum Issuer, PKCE S256, public client", () => {
  const m = baueAsMetadata("https://h/functions/v1/oauth") as any;
  assertEquals(m.issuer, "https://h/functions/v1/oauth");
  assertEquals(m.authorization_endpoint, "https://h/functions/v1/oauth/authorize");
  assertEquals(m.token_endpoint, "https://h/functions/v1/oauth/token");
  assertEquals(m.registration_endpoint, "https://h/functions/v1/oauth/register");
  assertEquals(m.code_challenge_methods_supported, ["S256"]);
  assertEquals(m.token_endpoint_auth_methods_supported, ["none"]);
});

Deno.test("Resource-Metadaten verweisen auf den AS", () => {
  const m = baueResourceMetadata("https://h/functions/v1/mcp", "https://h/functions/v1/oauth") as any;
  assertEquals(m.resource, "https://h/functions/v1/mcp");
  assertEquals(m.authorization_servers, ["https://h/functions/v1/oauth"]);
});

Deno.test("Resource-Metadaten-URL", () => {
  assertEquals(ressourcenMetadatenUrl("https://h/o"), "https://h/o/.well-known/oauth-protected-resource");
});

Deno.test("mcpPfadRest: Slug hinter /functions/v1/mcp", () => {
  assertEquals(mcpPfadRest("/functions/v1/mcp/vaneja-4c331e"), "/vaneja-4c331e");
  assertEquals(mcpPfadRest("/functions/v1/mcp"), "");
  assertEquals(mcpPfadRest("/functions/v1/mcp/"), "/");
  assertEquals(mcpPfadRest("/functions/v1/api"), "");
});

Deno.test("mcpRessource: Basis + Slug, ohne Slug bleibt die Basis", () => {
  const b = "https://h/functions/v1/mcp";
  assertEquals(mcpRessource(b, "/vaneja-4c331e"), "https://h/functions/v1/mcp/vaneja-4c331e");
  assertEquals(mcpRessource(b, "vaneja-4c331e"), "https://h/functions/v1/mcp/vaneja-4c331e");
  assertEquals(mcpRessource(b, "/"), b);
  assertEquals(mcpRessource(b, ""), b);
});

Deno.test("Metadaten-URL nach RFC 9728: well-known ZWISCHEN Host und Pfad", () => {
  assertEquals(
    ressourcenMetadatenUrlFuer("https://h/functions/v1/mcp/vaneja-4c331e"),
    "https://h/.well-known/oauth-protected-resource/functions/v1/mcp/vaneja-4c331e",
  );
  assertEquals(
    ressourcenMetadatenUrlFuer("https://h/functions/v1/mcp"),
    "https://h/.well-known/oauth-protected-resource/functions/v1/mcp",
  );
});

Deno.test("redirect_uris: HTTPS ok, localhost-HTTP ok", () => {
  assertEquals(pruefeRedirectUris(["https://chatgpt.com/cb"]), ["https://chatgpt.com/cb"]);
  assertEquals(pruefeRedirectUris(["http://localhost:8000/cb"]), ["http://localhost:8000/cb"]);
});

Deno.test("redirect_uris: leer, kaputt, oder http-nicht-localhost -> Fehler", () => {
  assertThrows(() => pruefeRedirectUris([]));
  assertThrows(() => pruefeRedirectUris(["kein-url"]));
  assertThrows(() => pruefeRedirectUris(["http://evil.example/cb"]));
});

Deno.test("authorize-Params: nur code + PKCE-S256", () => {
  assertEquals(pruefeAuthorizeParams({ response_type: "code", code_challenge: "abc", code_challenge_method: "S256" }).ok, true);
  assertEquals(pruefeAuthorizeParams({ response_type: "token", code_challenge: "abc", code_challenge_method: "S256" }).ok, false);
  assertEquals(pruefeAuthorizeParams({ response_type: "code", code_challenge: "", code_challenge_method: "S256" }).ok, false);
  assertEquals(pruefeAuthorizeParams({ response_type: "code", code_challenge: "abc", code_challenge_method: "plain" }).ok, false);
});

Deno.test("redirectMitCode hängt code + state an, behält vorhandene Query", () => {
  const u = redirectMitCode("https://chatgpt.com/cb?x=1", "CODE", "STATE");
  const p = new URL(u);
  assertEquals(p.searchParams.get("code"), "CODE");
  assertEquals(p.searchParams.get("state"), "STATE");
  assertEquals(p.searchParams.get("x"), "1");
});

Deno.test("escHtml neutralisiert Sonderzeichen", () => {
  assertEquals(escHtml(`<b>"&'`), "&lt;b&gt;&quot;&amp;&#39;");
});

Deno.test("PKCE S256 gegen RFC-7636-Testvektor", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assertEquals(await pkceS256(verifier), challenge);
  assertEquals(await pkceStimmt(verifier, challenge), true);
  assertEquals(await pkceStimmt("falsch", challenge), false);
  assertEquals(await pkceStimmt(verifier, ""), false);
});

Deno.test("Ticket: sign -> prüfen roundtrip; abgelaufen/verfälscht -> null", async () => {
  const secret = "server-secret";
  const exp = 1_000_000;
  const t = await signeTicket(secret, "user-123", exp);
  assertEquals(await pruefeTicket(secret, t, 999_999), "user-123"); // vor Ablauf
  assertEquals(await pruefeTicket(secret, t, 1_000_001), null);      // abgelaufen
  assertEquals(await pruefeTicket("anderes-secret", t, 999_999), null); // falsches Secret
  assertEquals(await pruefeTicket(secret, t + "x", 999_999), null);  // verfälscht
});

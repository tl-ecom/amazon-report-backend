import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { baueAsMetadata, baueResourceMetadata, pruefeRedirectUris, ressourcenMetadatenUrl } from "./oauth.ts";

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

Deno.test("redirect_uris: HTTPS ok, localhost-HTTP ok", () => {
  assertEquals(pruefeRedirectUris(["https://chatgpt.com/cb"]), ["https://chatgpt.com/cb"]);
  assertEquals(pruefeRedirectUris(["http://localhost:8000/cb"]), ["http://localhost:8000/cb"]);
});

Deno.test("redirect_uris: leer, kaputt, oder http-nicht-localhost -> Fehler", () => {
  assertThrows(() => pruefeRedirectUris([]));
  assertThrows(() => pruefeRedirectUris(["kein-url"]));
  assertThrows(() => pruefeRedirectUris(["http://evil.example/cb"]));
});

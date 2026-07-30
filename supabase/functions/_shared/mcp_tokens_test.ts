import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { mcpConnectorUrl, mcpDirektUrl, slugFuerTenant } from "./mcp_tokens.ts";

Deno.test("mcpConnectorUrl: Token in der Query, Basis-URL ohne Doppel-Slash", () => {
  assertEquals(
    mcpConnectorUrl("https://x.supabase.co", "oppulse_ab12"),
    "https://x.supabase.co/functions/v1/mcp-url?token=oppulse_ab12",
  );
  // trailing slash der Basis wird entfernt (kein //functions)
  assertEquals(
    mcpConnectorUrl("https://x.supabase.co/", "t"),
    "https://x.supabase.co/functions/v1/mcp-url?token=t",
  );
});

Deno.test("mcpDirektUrl: Endpoint ohne Token", () => {
  assertEquals(mcpDirektUrl("https://x.supabase.co/"), "https://x.supabase.co/functions/v1/mcp");
  assertMatch(mcpDirektUrl("https://x.supabase.co"), /\/functions\/v1\/mcp$/);
});

Deno.test("slugFuerTenant: Name + kurzer Tenant-Suffix, robust bei Sonderzeichen/leer", () => {
  assertEquals(slugFuerTenant("Vaneja", "4c331e70-809d-4590-a587-1e917f9db6ca"), "vaneja-4c331e");
  assertEquals(slugFuerTenant("e-One Ventures GmbH!", "931be15d-a463-4029-b7af-d796e790ed3c"), "e-one-ventures-gmbh-931be1");
  // leerer/zeichenloser Name -> nur der Suffix (immer noch je Firma eindeutig)
  assertEquals(slugFuerTenant("", "931be15d-aaaa"), "931be1");
});

Deno.test("URLs mit Slug: je Firma eigener Pfad (ChatGPT sieht getrennte Connectors)", () => {
  assertEquals(
    mcpConnectorUrl("https://x.supabase.co", "oppulse_ab12", "vaneja-4c331e"),
    "https://x.supabase.co/functions/v1/mcp-url/vaneja-4c331e?token=oppulse_ab12",
  );
  assertEquals(
    mcpDirektUrl("https://x.supabase.co", "eone-931be1"),
    "https://x.supabase.co/functions/v1/mcp/eone-931be1",
  );
});

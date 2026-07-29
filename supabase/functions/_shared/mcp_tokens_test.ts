import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { mcpConnectorUrl, mcpDirektUrl } from "./mcp_tokens.ts";

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

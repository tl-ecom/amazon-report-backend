import { assertEquals } from "jsr:@std/assert@1";
import { naechsterStatus } from "./flightrecorder.ts";

Deno.test("Klassifikation -> Status", () => {
  assertEquals(naechsterStatus("geplanter_test"), { status: "bestaetigt", requires_context: false });
  assertEquals(naechsterStatus("operative_anpassung"), { status: "bestaetigt", requires_context: false });
  assertEquals(naechsterStatus("extern"), { status: "bestaetigt", requires_context: false });
  assertEquals(naechsterStatus("nicht_relevant"), { status: "ignoriert", requires_context: false });
  // "spaeter" verschiebt die Klärung — bleibt offen.
  assertEquals(naechsterStatus("spaeter"), { status: "kontext_erforderlich", requires_context: true });
});

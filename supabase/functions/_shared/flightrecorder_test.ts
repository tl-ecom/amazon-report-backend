import { assertEquals } from "jsr:@std/assert@1";
import { baueManuelleAenderung, naechsterStatus } from "./flightrecorder.ts";

Deno.test("Klassifikation -> Status", () => {
  assertEquals(naechsterStatus("geplanter_test"), { status: "bestaetigt", requires_context: false });
  assertEquals(naechsterStatus("operative_anpassung"), { status: "bestaetigt", requires_context: false });
  assertEquals(naechsterStatus("extern"), { status: "bestaetigt", requires_context: false });
  assertEquals(naechsterStatus("nicht_relevant"), { status: "ignoriert", requires_context: false });
  // "spaeter" verschiebt die Klärung — bleibt offen.
  assertEquals(naechsterStatus("spaeter"), { status: "kontext_erforderlich", requires_context: true });
});

Deno.test("baueManuelleAenderung: gültige Eingabe -> manuelle Zeile", () => {
  const { row, fehler } = baueManuelleAenderung(
    "t1",
    { asin: "B01", event_type: "bild_geaendert", effective_at: "2026-07-20", new_value: "neues Hauptbild", note: "A/B" },
    "uuid-1",
    "2026-07-28",
  );
  assertEquals(fehler, undefined);
  assertEquals(row?.tenant_id, "t1");
  assertEquals(row?.asin, "B01");
  assertEquals(row?.event_type, "bild_geaendert");
  assertEquals(row?.source, "manuell");
  assertEquals(row?.detected_automatically, false);
  assertEquals(row?.status, "bestaetigt");
  assertEquals(row?.requires_context, false);
  assertEquals(row?.effective_at, "2026-07-20");
  assertEquals(row?.relevance, "informativ");
  assertEquals(row?.duplicate_key, "manuell|uuid-1");
});

Deno.test("baueManuelleAenderung: unbekannter Typ -> Fehler", () => {
  const { row, fehler } = baueManuelleAenderung("t1", { event_type: "hack" }, "u", "2026-07-28");
  assertEquals(row, undefined);
  assertEquals(fehler, "Unbekannter Änderungstyp.");
});

Deno.test("baueManuelleAenderung: fehlendes/ungültiges Datum -> heute; ungültige Relevanz -> informativ", () => {
  const { row } = baueManuelleAenderung(
    "t1",
    { event_type: "sonstiges", effective_at: "quatsch", relevance: "riesig" },
    "u",
    "2026-07-28",
  );
  assertEquals(row?.effective_at, "2026-07-28");
  assertEquals(row?.relevance, "informativ");
  assertEquals(row?.asin, null);
});

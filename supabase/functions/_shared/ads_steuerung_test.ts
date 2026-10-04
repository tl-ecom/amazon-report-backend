import { assertEquals } from "jsr:@std/assert@1";
import { sperre, steuerung } from "./ads_steuerung.ts";

// Echte Vaneja-Kampagnen: Kratzbrett Hauptkampagne (H10-KI), Biomülleimer ASIN (Pulse).
const vaneja = [
  { campaign_id: "560999216254376", modus: "h10" },
  { campaign_id: "95040867776815", modus: "pulse" },
];

Deno.test("H10-Kampagne: kein Gebot ueber Pulse, Struktur schon", () => {
  const m = steuerung(vaneja)("560999216254376");
  assertEquals(m, "h10");
  assertEquals(typeof sperre(m, "gebot"), "string");
  assertEquals(sperre(m, "struktur"), null);
});

Deno.test("Pulse-Kampagne: alles erlaubt", () => {
  const m = steuerung(vaneja)(95040867776815);
  assertEquals(sperre(m, "gebot"), null);
  assertEquals(sperre(m, "struktur"), null);
});

Deno.test("nicht gelistete Kampagne eines Mandanten mit Regel: nur Analyse", () => {
  // Papiertüten — kein verwaltetes Produkt.
  const m = steuerung(vaneja)("95723114588600");
  assertEquals(m, "nur_analyse");
  assertEquals(typeof sperre(m, "gebot"), "string");
  assertEquals(typeof sperre(m, "struktur"), "string");
});

Deno.test("Mandant ohne Zeilen: keine Regel", () => {
  assertEquals(steuerung([])("1"), "pulse");
});

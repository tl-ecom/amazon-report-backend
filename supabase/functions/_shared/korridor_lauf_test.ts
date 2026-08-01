import { assertEquals } from "jsr:@std/assert@1";
import { baueKlassen } from "./korridor_lauf.ts";

// Zeile aus fee_schedule, wie PostgREST sie liefert (Zahlen als Strings).
function zeile(over: Record<string, unknown> = {}) {
  return {
    marketplace: "DE", size_tier: "StandardEnvelope", amazon_klasse_de: "Standardumschlag",
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: "33", max_median_side_cm: "23", max_shortest_side_cm: "2.5",
    max_weight_g: "210", fee_eur: "2.57",
    grundgebuehr_eur: null, zuschlag_je_100g_eur: null,
    gueltig_ab: "2026-07-01", ...over,
  };
}

Deno.test("baueKlassen: Gewichtsstufen einer Klasse landen in EINER Klasse", () => {
  const k = baueKlassen([zeile(), zeile({ max_weight_g: "460", fee_eur: "2.68" })]);
  assertEquals(k.length, 1);
  assertEquals(k[0].stufen, [
    { max_weight_g: 210, fee_eur: 2.57 },
    { max_weight_g: 460, fee_eur: 2.68 },
  ]);
});

Deno.test("baueKlassen: Standardtarif und Niedrigpreisversand bleiben getrennt", () => {
  // Beide Tabellen kennen „StandardEnvelope". Ueber einen gemeinsamen Schluessel
  // fielen ihre Stufen in einen Topf — und die guenstigere gewaenne quer ueber
  // zwei Tarife hinweg.
  const k = baueKlassen([
    zeile(),
    zeile({ tarif: "niedrigpreis", preis_grenze_cents: "2000", fee_eur: "2.10" }),
  ]);
  assertEquals(k.length, 2);
  const std = k.find((x) => x.tarif === "standard")!;
  const np = k.find((x) => x.tarif === "niedrigpreis")!;
  assertEquals(std.stufen, [{ max_weight_g: 210, fee_eur: 2.57 }]);
  assertEquals(np.stufen, [{ max_weight_g: 210, fee_eur: 2.10 }]);
  assertEquals(np.preis_grenze_cents, 2000);
  assertEquals(std.preis_grenze_cents, null);
});

Deno.test("baueKlassen: fehlende Tarifspalte gilt als Standardtarif", () => {
  // Zeilen, die vor der Tarifspalte importiert wurden, sind Standardzeilen.
  const k = baueKlassen([zeile({ tarif: undefined })]);
  assertEquals(k[0].tarif, "standard");
});

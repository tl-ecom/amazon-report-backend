// Tests für ads_produkt_lage.ts. Zahlen: Vaneja, 7 Tage bis 01.10.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueProduktLage, type LageZeile } from "./ads_produkt_lage.ts";

const z = (produkt: string, modus: "h10" | "pulse", fenster: "aktuell" | "davor", kampagnen: number, clicks: number, spend_cents: number, sales_cents: number, orders: number): LageZeile =>
  ({ produkt, modus, fenster, kampagnen, impressions: 0, clicks, spend_cents, sales_cents, orders });

const VANEJA = [
  z("Kratzbrett", "h10", "aktuell", 8, 284, 32300, 84310, 52),
  z("Kratzbrett", "h10", "davor", 8, 255, 28270, 60232, 37),
  z("Kratzbrett", "pulse", "aktuell", 4, 0, 0, 0, 0),
  z("Kratzbrett", "pulse", "davor", 4, 46, 5347, 5956, 4),
  z("Biomülleimer", "pulse", "aktuell", 13, 360, 20001, 88917, 41),
  z("Biomülleimer", "pulse", "davor", 13, 392, 21447, 90498, 40),
];

Deno.test("Produkt-Lage: Teile summieren sich zum Ganzen, Differenz gegen das Vorfenster", () => {
  const k = baueProduktLage(VANEJA, { Kratzbrett: 2 }).find((p) => p.produkt === "Kratzbrett")!;
  assertEquals(k.gesamt.aktuell.kosten, 323);
  assertEquals(k.gesamt.davor.kosten, 336.17);
  assertEquals(k.h10.umsatz_differenz, 240.78);
  assertEquals(k.gesamt.bestellungen_differenz, 52 - 41);
  assertEquals(k.h10_anteil_kosten, 1);
  assertEquals(k.kampagnentage_budget_leer, 2);
  assertEquals(k.gesamt.kampagnen, 12);
});

Deno.test("Produkt-Lage: TACoS gegen alle Bestellungen; ohne Bestell-Eintrag unbekannt statt 0", () => {
  // Kratzbrett: Werbeumsatz stieg (662 -> 843 EUR), der Gesamtumsatz fiel (1.771 -> 1.530 EUR).
  const p = baueProduktLage(VANEJA, {}, [
    { produkt: "Kratzbrett", fenster: "aktuell", umsatz_cents: 152968, einheiten: 84 },
    { produkt: "Kratzbrett", fenster: "davor", umsatz_cents: 177075, einheiten: 99 },
  ], { Kratzbrett: ["B0FLKN42D4"] });
  const k = p.find((x) => x.produkt === "Kratzbrett")!;
  assertEquals(k.alle_bestellungen.aktuell.umsatz, 1529.68);
  assertEquals(k.alle_bestellungen.aktuell.tacos, 0.2112);
  assertEquals(k.alle_bestellungen.davor.tacos, 0.1898);
  assertEquals(k.alle_bestellungen.aktuell.werbeanteil, 0.551);
  assertEquals(k.asins, ["B0FLKN42D4"]);
  const bio = p.find((x) => x.produkt === "Biomülleimer")!;
  assertEquals(bio.alle_bestellungen.aktuell, { umsatz: null, einheiten: null, tacos: null, werbeanteil: null });
});

Deno.test("Produkt-Lage: ohne Umsatz ist der ACoS unbekannt, nicht 0; ohne H10-Kampagnen ein leerer Teil", () => {
  const p = baueProduktLage(VANEJA, {});
  // Sortiert nach Kosten im aktuellen Fenster.
  assertEquals(p.map((x) => x.produkt), ["Kratzbrett", "Biomülleimer"]);
  assertEquals(p[0].pulse.aktuell.acos, null);
  const bio = p[1];
  assertEquals(bio.h10.kampagnen, 0);
  assertEquals(bio.h10_anteil_kosten, 0);
  assertEquals(bio.pulse.aktuell.acos, 0.2249);
  assertEquals(bio.kampagnentage_budget_leer, 0);
});

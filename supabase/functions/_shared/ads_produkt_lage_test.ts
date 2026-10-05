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

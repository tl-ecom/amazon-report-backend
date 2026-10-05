// Tests für ads_produkt_lage.ts. Zahlen: Vaneja, 7 Tage bis 01.10.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { asinMargenAus, baueProduktLage, margeFuer, type LageZeile } from "./ads_produkt_lage.ts";

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
  // Ohne Marge kein Gewinn — auch nicht 0.
  assertEquals(k.break_even_tacos, null);
  assertEquals(k.gewinn_nach_werbung.aktuell, null);
});

Deno.test("Marge: nach Umsatz gewichtet; unbelastbare ASINs zählen nicht, zu viele davon heißt unbekannt", () => {
  // Vaneja, 90 Tage bis 05.10.2026 (Produktübersicht).
  const m = asinMargenAus([
    { asin: "B0FKNKD93K", umsatz_brutto: 29133.08, nettogewinn_vor_werbung: 12734.01, gebuehren_anteilig: true },
    { asin: "B0FKNHNW27", umsatz_brutto: 13627.19, nettogewinn_vor_werbung: 6054.26, gebuehren_anteilig: true },
    { asin: "B0FKNN9CCJ", umsatz_brutto: 164.88, nettogewinn_vor_werbung: 10.54, gebuehren_anteilig: true },
    { asin: "B0H3L8SQYD", umsatz_brutto: 209.58, nettogewinn_vor_werbung: 155.43, gebuehren_anteilig: false, gebuehren_vollstaendig: false },
    { asin: "B0OHNEUMSATZ", umsatz_brutto: 0, nettogewinn_vor_werbung: 0 },
  ]);
  // Etagere: die kleine ASIN mit 6 % Marge zieht das Produkt nicht auf 6 %.
  assertEquals(margeFuer(["B0FKNKD93K", "b0fknhnw27", "B0FKNN9CCJ"], m), 0.4379);
  // Kauknochen: Gebühren noch nicht abgerechnet — 74 % wären zu schön.
  assertEquals(margeFuer(["B0H3L8SQYD"], m), null);
  assertEquals(margeFuer(["B0OHNEUMSATZ", "B0FEHLT"], m), null);
});

Deno.test("Produkt-Lage: Gewinn nach Werbung aus der Marge; ohne Umsatz unbekannt", () => {
  const gesamt = [
    { produkt: "Kratzbrett", fenster: "aktuell" as const, umsatz_cents: 152968, einheiten: 84 },
    { produkt: "Kratzbrett", fenster: "davor" as const, umsatz_cents: 177075, einheiten: 99 },
  ];
  const margen = new Map([["B0FLKN42D4", { umsatz_brutto: 1000, vor_werbung: 250, belastbar: true }]]);
  const p = baueProduktLage(VANEJA, {}, gesamt, { Kratzbrett: ["B0FLKN42D4"], "Biomülleimer": ["b0flkn42d4"] }, margen);
  const k = p.find((x) => x.produkt === "Kratzbrett")!;
  assertEquals(k.break_even_tacos, 0.25);
  // 1.529,68 x 0,25 − 323,00 und 1.770,75 x 0,25 − 336,17
  assertEquals(k.gewinn_nach_werbung.aktuell, 59.42);
  assertEquals(k.gewinn_nach_werbung.davor, 106.52);
  const bio = p.find((x) => x.produkt === "Biomülleimer")!;
  assertEquals(bio.break_even_tacos, 0.25);
  assertEquals(bio.gewinn_nach_werbung.aktuell, null);
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

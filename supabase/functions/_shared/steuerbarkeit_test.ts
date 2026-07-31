import { assertEquals } from "jsr:@std/assert@1";
import {
  analysiereSteuerbarkeit, hebelLabel,
  type Klassifizierung, type Position,
} from "./steuerbarkeit.ts";

const KLASSEN: Klassifizierung[] = [
  { fee_typ: "Commission", label: "Verkaufsgebühr", steuerbar: false, hebel: null, hebel_alternativ: null, massnahme: null },
  { fee_typ: "FBAPerUnitFulfillmentFee", label: "FBA-Versandgebühr", steuerbar: false, hebel: null, hebel_alternativ: null, massnahme: null },
  { fee_typ: "FBALowInventoryLevelFee", label: "Low-Inventory-Level-Fee", steuerbar: true, hebel: "operations", hebel_alternativ: null, massnahme: "Reichweite über die Schwelle heben." },
  { fee_typ: "FBAStorageFee", label: "Lagergebühr", steuerbar: true, hebel: "operations", hebel_alternativ: null, massnahme: "Überbestand abbauen." },
  { fee_typ: "FBAReturnsProcessingFee", label: "Returns Processing Fee", steuerbar: true, hebel: "content", hebel_alternativ: "produkt_market_fit", massnahme: "Retourengründe auswerten." },
];

// Gebucht wird negativ (Kosten). Der Analyse-Code dreht das um.
function pos(fee_typ: string, eur: number, quelle: Position["quelle"] = "abrechnung"): Position {
  return { fee_typ, betrag_cents: Math.round(-eur * 100), quelle };
}

Deno.test("analysiereSteuerbarkeit: Kernaussage nennt Betrag, Anteil und Hebel", () => {
  const r = analysiereSteuerbarkeit([
    pos("Commission", 800), pos("FBAPerUnitFulfillmentFee", 400),
    pos("FBALowInventoryLevelFee", 250), pos("FBAStorageFee", 60, "lager"),
  ], KLASSEN);
  assertEquals(r.gesamt, 1510);
  assertEquals(r.nicht_steuerbar, 1200);
  assertEquals(r.steuerbar, 310);
  assertEquals(r.unklassifiziert, 0);
  assertEquals(r.anteil_steuerbar, 20.5);
  assertEquals(r.belastbar, true);
  // Genau das Format aus der Spezifikation.
  assertEquals(r.kernaussage.includes("310.00 € selbst erzeugt"), true);
  assertEquals(r.kernaussage.includes("Operations"), true);
});

Deno.test("analysiereSteuerbarkeit: unbekannter Typ landet NICHT bei nicht steuerbar", () => {
  // Als "nicht steuerbar" zu buchen waere eine Entwarnung, die niemand geprueft hat.
  const r = analysiereSteuerbarkeit([
    pos("Commission", 500), pos("VoelligNeueGebuehr", 300),
  ], KLASSEN);
  assertEquals(r.nicht_steuerbar, 500);
  assertEquals(r.steuerbar, 0);
  assertEquals(r.unklassifiziert, 300);
  assertEquals(r.offene_typen.map((o) => o.fee_typ), ["VoelligNeueGebuehr"]);
  assertEquals(r.belastbar, false); // 37 % unklassifiziert
  assertEquals(r.hinweis?.includes("nicht eingeordnet"), true);
});

Deno.test("analysiereSteuerbarkeit: Anteil rechnet auf den klassifizierten Teil", () => {
  const r = analysiereSteuerbarkeit([
    pos("Commission", 800), pos("FBALowInventoryLevelFee", 200), pos("Unbekannt", 1000),
  ], KLASSEN);
  // 200 von 1000 klassifizierten -> 20 %, NICHT 200 von 2000.
  assertEquals(r.anteil_steuerbar, 20);
  assertEquals(r.unklassifiziert, 1000);
});

Deno.test("analysiereSteuerbarkeit: zwei moegliche Hebel -> Hypothese, keine Wahl", () => {
  const r = analysiereSteuerbarkeit([pos("FBAReturnsProcessingFee", 400)], KLASSEN);
  const hebel = r.je_hebel.map((h) => h.hebel).sort();
  assertEquals(hebel, ["content", "produkt_market_fit"]);
  assertEquals(r.je_hebel.every((h) => h.hypothese), true);
  assertEquals(r.kernaussage.includes("Hypothese"), true);
  // Beide tragen den vollen Betrag — die Summe je Hebel ist bewusst keine
  // Aufteilung, sondern zwei Lesarten desselben Betrags.
  assertEquals(r.je_hebel[0].betrag, 400);
});

Deno.test("analysiereSteuerbarkeit: Umsatzsteuer wird herausgerechnet", () => {
  const r = analysiereSteuerbarkeit([
    pos("Commission", 1190), pos("FBAStorageFee", 119, "lager"),
  ], KLASSEN, 1.19);
  assertEquals(r.nicht_steuerbar, 1000);
  assertEquals(r.steuerbar, 100);
  assertEquals(r.gesamt, 1100);
});

Deno.test("analysiereSteuerbarkeit: Faktor 1 laesst die Betraege unveraendert", () => {
  const r = analysiereSteuerbarkeit([pos("Commission", 1190)], KLASSEN, 1);
  assertEquals(r.nicht_steuerbar, 1190);
  // Unsinnige Faktoren duerfen nichts kaputtmachen.
  assertEquals(analysiereSteuerbarkeit([pos("Commission", 1190)], KLASSEN, 0.5).nicht_steuerbar, 1190);
  assertEquals(analysiereSteuerbarkeit([pos("Commission", 1190)], KLASSEN, NaN).nicht_steuerbar, 1190);
});

Deno.test("analysiereSteuerbarkeit: Gutschrift mindert, statt zu addieren", () => {
  const r = analysiereSteuerbarkeit([
    pos("Commission", 500),
    { fee_typ: "Commission", betrag_cents: 10000, quelle: "abrechnung" }, // Erstattung
  ], KLASSEN);
  assertEquals(r.nicht_steuerbar, 400);
});

Deno.test("analysiereSteuerbarkeit: Quellen werden mitgefuehrt", () => {
  const r = analysiereSteuerbarkeit([
    pos("FBAStorageFee", 60, "lager"), pos("FBAStorageFee", 40, "abrechnung"),
  ], KLASSEN);
  assertEquals(r.je_typ[0].quellen, ["abrechnung", "lager"]);
  assertEquals(r.je_typ[0].betrag, 100);
});

Deno.test("analysiereSteuerbarkeit: nichts selbst erzeugt wird als Ergebnis gesagt", () => {
  const r = analysiereSteuerbarkeit([pos("Commission", 500)], KLASSEN);
  assertEquals(r.steuerbar, 0);
  assertEquals(r.kernaussage.includes("nichts selbst erzeugt"), true);
  assertEquals(r.je_hebel.length, 0);
});

Deno.test("analysiereSteuerbarkeit: leere Eingabe erfindet keine Aussage", () => {
  const r = analysiereSteuerbarkeit([], KLASSEN);
  assertEquals(r.gesamt, 0);
  assertEquals(r.anteil_steuerbar, null);
  assertEquals(r.belastbar, false);
  assertEquals(r.kernaussage.includes("keine Gebührenpositionen"), true);
});

Deno.test("hebelLabel: geschlossene Fuenferliste, Unbekanntes bleibt stehen", () => {
  assertEquals(hebelLabel("operations"), "Operations / Supply Chain / Zahlen beherrschen");
  assertEquals(hebelLabel("produkt_market_fit"), "Produkt-Market-Fit");
  assertEquals(hebelLabel("erfundener_hebel"), "erfundener_hebel");
});

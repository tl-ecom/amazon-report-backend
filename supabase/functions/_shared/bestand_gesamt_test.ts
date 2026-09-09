import { assertEquals } from "jsr:@std/assert@1";
import { type AmazonBestand, bewerteKapital, type ExternBestand, vereinigeBestand } from "./bestand_gesamt.ts";

const amazon: AmazonBestand[] = [
  { asin: "B000000001", verfuegbar: 820, reserviert: 30, inbound: 100, stand: "2026-09-10T04:30:00Z", quelle: "myi" },
];
const extern = (zusatz: Partial<ExternBestand>[] = []): ExternBestand[] => [
  { asin: "B000000001", sku: "ZD-1", lagerart: "dreipl", lagername: "Logistiker", menge: 1350, quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null },
  { asin: "B000000001", sku: "ZD-1", lagerart: "ordered", lagername: "Ordered", menge: 2000, quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null },
  ...zusatz.map((z) => ({
    asin: "B000000001", sku: "ZD-1", lagerart: "extern_lager" as const, lagername: "x", menge: 0,
    quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null, ...z,
  })),
];

Deno.test("vereinigeBestand: Beispiel aus der Aufgabe — physisch 2.170, Versorgung 4.170", () => {
  const v = vereinigeBestand(amazon, extern());
  const z = v.zeilen[0];
  assertEquals(z.fba_verfuegbar, 820);
  assertEquals(z.fba_reserviert, 30);
  assertEquals(z.amazon_inbound, 100);
  assertEquals(z.extern_physisch, 1350);
  assertEquals(z.ordered, 2000);
  // physisch = 820 + 30 reserviert + 1350 — die Aufgabe nennt 2.170 ohne Reserviert.
  assertEquals(z.physisch_gesamt, 2200);
  assertEquals(z.pipeline_gesamt, 2100);
  assertEquals(z.versorgung_gesamt, 4300);
  assertEquals(z.skus, ["ZD-1"]);
  assertEquals(z.quellen, ["amazon", "sellerboard"]);
  assertEquals(z.fba_quelle, "amazon");
});

Deno.test("vereinigeBestand: ohne Reserviert exakt die Zahlen der Aufgabe", () => {
  const v = vereinigeBestand(
    [{ ...amazon[0], reserviert: null, inbound: null }],
    extern(),
  );
  assertEquals(v.zeilen[0].physisch_gesamt, 2170);
  assertEquals(v.zeilen[0].versorgung_gesamt, 4170);
});

Deno.test("vereinigeBestand: Sellerboard-FBA wird bei SP-API-Daten NICHT doppelt gezaehlt", () => {
  const v = vereinigeBestand(amazon, extern([
    { lagerart: "fba_verfuegbar", lagername: "FBA stock", menge: 815 },
    { lagerart: "inbound_fba", lagername: "Sent to FBA", menge: 100 },
  ]));
  const z = v.zeilen[0];
  assertEquals(z.fba_verfuegbar, 820);           // Amazon bleibt
  assertEquals(z.amazon_inbound, 100);
  assertEquals(z.doppelt_uebersprungen.map((d) => d.menge), [815, 100]);
  assertEquals(v.summen.doppelt_uebersprungen, 915);
  assertEquals(z.physisch_gesamt, 2200);
});

Deno.test("vereinigeBestand: ohne Amazon fuellt Sellerboard die FBA-Spalten, gekennzeichnet", () => {
  const v = vereinigeBestand([], extern([
    { lagerart: "fba_verfuegbar", lagername: "FBA stock", menge: 815 },
  ]));
  const z = v.zeilen[0];
  assertEquals(v.amazon_vorhanden, false);
  assertEquals(z.fba_verfuegbar, 815);
  assertEquals(z.fba_quelle, "sellerboard");
  assertEquals(z.doppelt_uebersprungen, []);
  assertEquals(z.physisch_gesamt, 815 + 1350);
});

Deno.test("vereinigeBestand: AWD und Transit sind Pipeline, nicht physisch", () => {
  const v = vereinigeBestand(amazon, extern([
    { lagerart: "awd", lagername: "AWD", menge: 400 },
    { lagerart: "sonstige_pipeline", lagername: "In transit", menge: 50 },
  ]));
  const z = v.zeilen[0];
  assertEquals(z.pipeline_sonstig, 450);
  assertEquals(z.extern_physisch, 1350);
  assertEquals(z.pipeline_gesamt, 100 + 2000 + 450);
});

Deno.test("vereinigeBestand: unbekannte Menge zaehlt nicht, ASIN-lose Zeile ist nicht zuordenbar", () => {
  const v = vereinigeBestand(amazon, [
    ...extern(),
    { asin: "B000000001", sku: "ZD-1", lagerart: "prep_center", lagername: "Prep", menge: null, quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null },
    { asin: null, sku: "UNBEKANNT", lagerart: "extern_lager", lagername: "Lager", menge: 77, quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null },
  ]);
  assertEquals(v.zeilen.length, 1);
  assertEquals(v.zeilen[0].extern_physisch, 1350);
  assertEquals(v.nicht_zuordenbar, [{ sku: "UNBEKANNT", lagerart: "extern_lager", lagername: "Lager", menge: 77 }]);
});

Deno.test("vereinigeBestand: ASIN nur extern (kein FBA-Datensatz) bleibt mit null-FBA", () => {
  const v = vereinigeBestand(amazon, [
    { asin: "B000000002", sku: "NEU-1", lagerart: "ordered", lagername: "Ordered", menge: 500, quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null },
  ]);
  const neu = v.zeilen.find((z) => z.asin === "B000000002")!;
  assertEquals(neu.fba_verfuegbar, null);  // unbekannt, nicht 0
  assertEquals(neu.ordered, 500);
  assertEquals(neu.physisch_gesamt, 0);
  assertEquals(neu.versorgung_gesamt, 500);
});

Deno.test("bewerteKapital: Werte je Klasse, ausserhalb Amazon, Reichweiten", () => {
  const v = vereinigeBestand([{ ...amazon[0], reserviert: null, inbound: 100 }], extern());
  const ek = new Map([["B000000001", 500]]);     // 5,00 € je Stueck
  const velo = new Map([["B000000001", 10]]);    // 10 Stk/Tag
  const { zeilen, kapital } = bewerteKapital(v.zeilen, ek, velo);
  const z = zeilen[0];
  assertEquals(z.wert_fba_cents, 820 * 500);
  assertEquals(z.wert_extern_cents, 1350 * 500);
  assertEquals(z.wert_ordered_cents, 2000 * 500);
  assertEquals(z.wert_inbound_cents, 100 * 500);
  assertEquals(z.reichweite_fba_tage, 82);
  assertEquals(z.reichweite_physisch_tage, 217);
  assertEquals(z.reichweite_versorgung_tage, 427);
  assertEquals(kapital.wert_cents.ausserhalb_amazon, (1350 + 2000) * 500);
  assertEquals(kapital.wert_cents.physisch, (820 + 1350) * 500);
  assertEquals(kapital.wert_cents.gesamt, (820 + 1350 + 2000 + 100) * 500);
  assertEquals(kapital.ek_abdeckung, 1);
  assertEquals(kapital.reichweite_tage.physisch, 217);
  assertEquals(kapital.hinweise, []);
});

Deno.test("bewerteKapital: ohne EK bleibt der Wert null und die Abdeckung sinkt", () => {
  const v = vereinigeBestand(amazon, [
    ...extern(),
    { asin: "B000000002", sku: "N", lagerart: "extern_lager", lagername: "Lager", menge: 100, quelle: "sellerboard", stand: "2026-09-10T06:00:00Z", marketplace_id: null },
  ]);
  const { zeilen, kapital } = bewerteKapital(v.zeilen, new Map([["B000000001", 500]]), new Map());
  const ohne = zeilen.find((z) => z.asin === "B000000002")!;
  assertEquals(ohne.wert_extern_cents, null);
  assertEquals(ohne.reichweite_fba_tage, null);
  assertEquals(kapital.wert_cents.extern, 1350 * 500); // nur die bewertbare ASIN
  assertEquals(kapital.ek_abdeckung < 1, true);
  assertEquals(kapital.reichweite_tage.fba, null);
  assertEquals(kapital.hinweise.length, 2);
});

Deno.test("bewerteKapital: gar kein EK -> alle Werte null, nicht 0", () => {
  const { kapital } = bewerteKapital(vereinigeBestand(amazon, extern()).zeilen, new Map(), new Map());
  assertEquals(kapital.wert_cents.gesamt, null);
  assertEquals(kapital.wert_cents.ausserhalb_amazon, null);
  assertEquals(kapital.einheiten.versorgung, 820 + 30 + 100 + 1350 + 2000);
});

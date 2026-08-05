import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { alsPeriode, letzterZeitraum, parseSqpReport, zeitraumFuer, zeitraumListe } from "./sqp.ts";

const beispiel = {
  dataByAsin: [
    {
      asin: "B01",
      searchQueryData: { searchQuery: "kratzbrett", searchQueryVolume: 20866 },
      impressionData: { totalQueryImpressionCount: 100000, asinImpressionCount: 5000 },
      clickData: { totalClickCount: 1240, asinClickCount: 59 },
      purchaseData: { totalPurchaseCount: 300, asinPurchaseCount: 11, asinPurchaseShare: 0.0364 },
    },
    {
      asin: "B01",
      searchQueryData: { searchQuery: "katzen kratzbrett", searchQueryVolume: 7108 },
      impressionData: { totalQueryImpressionCount: 40000, asinImpressionCount: 50 }, // wenig -> dünn
      clickData: { totalClickCount: 428, asinClickCount: 2 },
      purchaseData: { totalPurchaseCount: 100, asinPurchaseCount: 0, asinPurchaseShare: 0 },
    },
    { searchQueryData: { searchQuery: "" } }, // leere Query -> raus
  ],
};

Deno.test("berechnet eigene/Markt-CTR + Index", () => {
  const z = parseSqpReport(beispiel);
  const r = z[0];
  assertEquals(r.search_query, "kratzbrett");
  assertEquals(r.volume, 20866);
  assertEquals(r.eigene_ctr, 1.2); // 59/5000 = 1,18 -> 1,2
  assertEquals(r.markt_ctr, 1.2); // 1240/100000 = 1,24 -> 1,2
  assertEquals(r.ctr_index, 0.95); // (59/5000)/(1240/100000)
});

Deno.test("berechnet CVR + Kaufanteil", () => {
  const r = parseSqpReport(beispiel)[0];
  assertEquals(r.eigene_cvr, 18.6); // 11/59
  assertEquals(r.markt_cvr, 24.2); // 300/1240
  assertEquals(r.kaufanteil, 3.7); // 11/300 aus Zählwerten
});

Deno.test("markiert dünne Datenbasis (wenig eigene Impressions/Klicks)", () => {
  const z = parseSqpReport(beispiel);
  assertEquals(z[0].duenn, false);
  assertEquals(z[1].duenn, true);
});

Deno.test("leere Query wird gefiltert, leerer Report kippt nicht um", () => {
  assertEquals(parseSqpReport(beispiel).length, 2);
  assertEquals(parseSqpReport(null), []);
  assertEquals(parseSqpReport({}), []);
  assertEquals(parseSqpReport({ dataByAsin: [] }), []);
});

Deno.test("keine Division durch 0", () => {
  const z = parseSqpReport({ dataByAsin: [{ searchQueryData: { searchQuery: "x", searchQueryVolume: 5 }, impressionData: {}, clickData: {}, purchaseData: {} }] });
  assertEquals(z[0].eigene_ctr, null);
  assertEquals(z[0].markt_ctr, null);
  assertEquals(z[0].ctr_index, null);
});

/* --- Zeiträume ------------------------------------------------------------ */

Deno.test("Woche wird auf Sonntag–Samstag gelegt", () => {
  // 2026-07-22 ist ein Mittwoch.
  assertEquals(zeitraumFuer("WEEK", "2026-07-22"), { von: "2026-07-19", bis: "2026-07-25" });
  // Ränder bleiben in ihrer eigenen Woche.
  assertEquals(zeitraumFuer("WEEK", "2026-07-19"), { von: "2026-07-19", bis: "2026-07-25" });
  assertEquals(zeitraumFuer("WEEK", "2026-07-25"), { von: "2026-07-19", bis: "2026-07-25" });
});

Deno.test("Monat wird auf 1. bis Monatsletzten gelegt (auch Februar/Schaltjahr)", () => {
  assertEquals(zeitraumFuer("MONTH", "2026-07-22"), { von: "2026-07-01", bis: "2026-07-31" });
  assertEquals(zeitraumFuer("MONTH", "2026-02-14"), { von: "2026-02-01", bis: "2026-02-28" });
  assertEquals(zeitraumFuer("MONTH", "2028-02-14"), { von: "2028-02-01", bis: "2028-02-29" });
});

Deno.test("letzter Zeitraum ist immer abgeschlossen", () => {
  // Mittwoch, 2026-08-05 -> letzte volle Woche endete Samstag, 2026-08-01.
  assertEquals(letzterZeitraum("WEEK", "2026-08-05"), { von: "2026-07-26", bis: "2026-08-01" });
  // Sonntag: die gestern zu Ende gegangene Woche, nicht die laufende.
  assertEquals(letzterZeitraum("WEEK", "2026-08-02"), { von: "2026-07-26", bis: "2026-08-01" });
  // Samstag: die laufende Woche endet heute und zählt noch nicht.
  assertEquals(letzterZeitraum("WEEK", "2026-08-01"), { von: "2026-07-19", bis: "2026-07-25" });
  assertEquals(letzterZeitraum("MONTH", "2026-08-05"), { von: "2026-07-01", bis: "2026-07-31" });
  assertEquals(letzterZeitraum("MONTH", "2026-01-15"), { von: "2025-12-01", bis: "2025-12-31" });
});

Deno.test("Auswahlliste zählt lückenlos rückwärts", () => {
  const wochen = zeitraumListe("WEEK", 3, "2026-08-05");
  assertEquals(wochen, [
    { von: "2026-07-26", bis: "2026-08-01" },
    { von: "2026-07-19", bis: "2026-07-25" },
    { von: "2026-07-12", bis: "2026-07-18" },
  ]);
  const monate = zeitraumListe("MONTH", 3, "2026-03-10");
  assertEquals(monate, [
    { von: "2026-02-01", bis: "2026-02-28" },
    { von: "2026-01-01", bis: "2026-01-31" },
    { von: "2025-12-01", bis: "2025-12-31" },
  ]);
  assertEquals(zeitraumListe("WEEK", 0, "2026-08-05"), []);
});

Deno.test("Periode fällt auf WEEK zurück, Datum wird geprüft", () => {
  assertEquals(alsPeriode("MONTH"), "MONTH");
  assertEquals(alsPeriode("month"), "MONTH");
  assertEquals(alsPeriode("QUARTER"), "WEEK");
  assertEquals(alsPeriode(undefined), "WEEK");
  assertThrows(() => zeitraumFuer("WEEK", "letzte Woche"));
});

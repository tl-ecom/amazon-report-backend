import { assertEquals } from "jsr:@std/assert@1";
import { parseSqpReport } from "./sqp.ts";

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

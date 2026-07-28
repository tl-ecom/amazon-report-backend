// Tests für product.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import { baueProductPerformance, Quelle } from "./product.ts";

// Payloads nach dem Muster der echten Reports vom 2026-07-17.
function salesQuelle(): Quelle {
  return {
    data_timestamp: "2026-07-17T09:00:00Z",
    payload: {
      reportSpecification: { dataStartTime: "2026-04-16", dataEndTime: "2026-07-15", marketplaceIds: ["A1PA6795UKMFR9"] },
      salesAndTrafficByAsin: [
        { childAsin: "B00CD2X6QS", salesByAsin: { unitsOrdered: 0, orderedProductSales: { amount: 0 } }, trafficByAsin: { sessions: 81, pageViews: 90 } },
        { childAsin: "B0DGTQJTPD", salesByAsin: { unitsOrdered: 2, orderedProductSales: { amount: 65.94 } }, trafficByAsin: { sessions: 41, pageViews: 50 } },
        { childAsin: "B0DNT2FDN9", salesByAsin: { unitsOrdered: 6, orderedProductSales: { amount: 48.12 } }, trafficByAsin: { sessions: 35, pageViews: 40 } },
      ],
    },
  };
}

function ordersQuelle(): Quelle {
  return {
    data_timestamp: "2026-07-17T10:00:00Z",
    payload: {
      format: "tsv",
      rows: [
        // B0DNT2FDN9: auch in S&T, Amazon.de
        { "amazon-order-id": "305-1", asin: "B0DNT2FDN9", quantity: "1", "item-price": "7.85", "sales-channel": "Amazon.de" },
        // B09JSHP49L: NUR Orders, fremde Kanäle
        { "amazon-order-id": "408-1", asin: "B09JSHP49L", quantity: "1", "item-price": "18.04", "sales-channel": "Amazon.com.be" },
        { "amazon-order-id": "S02-1", asin: "B09JSHP49L", quantity: "3", "item-price": "", "sales-channel": "Non-Amazon" },
        // B0DW43MJC9: NUR Orders, Non-Amazon, kein Preis
        { "amazon-order-id": "S02-2", asin: "B0DW43MJC9", quantity: "8", "item-price": "", "sales-channel": "Non-Amazon" },
      ],
    },
  };
}

function listingsQuelle(): Quelle {
  return {
    data_timestamp: "2026-07-17T11:00:00Z",
    payload: {
      format: "tsv",
      rows: [
        { asin1: "B00CD2X6QS", status: "Active", "fulfillment-channel": "DEFAULT", quantity: "5", price: "3.95" },
        { asin1: "B0DGTQJTPD", status: "Active", "fulfillment-channel": "DEFAULT", quantity: "12", price: "32.97" },
        { asin1: "B0DNT2FDN9", status: "Active", "fulfillment-channel": "DEFAULT", quantity: "3", price: "7.85" },
        // zwei Angebote für dieselbe ASIN (Aggregation testen)
        { asin1: "B0DPKD6PVB", status: "Active", "fulfillment-channel": "DEFAULT", quantity: "0", price: "9.99" },
        { asin1: "B0DPKD6PVB", status: "Inactive", "fulfillment-channel": "DEFAULT", quantity: "0", price: "10.99" },
      ],
    },
  };
}

// --- DER Grundsatz: Quellen werden NICHT verschmolzen ---
Deno.test("jede Quelle bleibt getrennt, mit eigenem Zeitraum/Stand", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  const b0d = r.produkte.find((p) => p.asin === "B0DNT2FDN9")!;

  // S&T-Teil trägt seinen Zeitraum + Marktplatz.
  assertEquals(b0d.sales_traffic!.zeitraum, { von: "2026-04-16", bis: "2026-07-15" });
  assertEquals(b0d.sales_traffic!.marktplatz, "A1PA6795UKMFR9");
  assertEquals(b0d.sales_traffic!.unitsOrdered, 6);
  // Orders-Teil trägt den Stand, nicht denselben Zeitraum.
  assertEquals(b0d.orders!.bestellungen, 1);
  assertEquals(b0d.orders!.stand, "2026-07-17T10:00:00Z");
  // Es gibt KEINE quellenübergreifende Summe.
  assertEquals((b0d as any).gesamtumsatz, undefined);
  // Die Warnung sagt es explizit.
  assertEquals(r.warnung.includes("NICHT zu"), true);
});

// --- Der wertvolle Insight: verkauft nur über fremde Kanäle ---
Deno.test("ASIN nur in Orders (fremder Kanal) wird als solcher erkannt", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  const b09 = r.produkte.find((p) => p.asin === "B09JSHP49L")!;

  assertEquals(b09.sales_traffic, null); // nicht im DE-S&T
  assertEquals(b09.orders!.kanaele, ["Amazon.com.be", "Non-Amazon"]);
  const hinweis = b09.hinweise.find((h) => h.includes("außerhalb des S&T"));
  assertEquals(typeof hinweis, "string");
});

// --- Traffic ohne Verkauf ---
Deno.test("hohe Sessions ohne Verkauf ergeben einen Conversion-Hinweis", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  const b00 = r.produkte.find((p) => p.asin === "B00CD2X6QS")!;
  assertEquals(b00.sales_traffic!.sessions, 81);
  assertEquals(b00.sales_traffic!.unitsOrdered, 0);
  assertEquals(typeof b00.hinweise.find((h) => h.includes("ohne einen einzigen Verkauf")), "string");
});

// --- Orders-Umsatz: unbekannt statt 0 bei MCF ---
Deno.test("ASIN mit ausschliesslich preislosen Orders meldet umsatz_bekannt=null", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  const b0w = r.produkte.find((p) => p.asin === "B0DW43MJC9")!;
  assertEquals(b0w.orders!.einheiten, 8);
  assertEquals(b0w.orders!.umsatz_bekannt, null); // nicht 0
  assertEquals(b0w.orders!.positionen_ohne_preis, 1);
});

Deno.test("ASIN mit gemischten Orders-Preisen meldet die bekannte Summe", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  const b09 = r.produkte.find((p) => p.asin === "B09JSHP49L")!;
  // 18.04 bekannt, eine Position ohne Preis.
  assertEquals(b09.orders!.umsatz_bekannt, 18.04);
  assertEquals(b09.orders!.positionen_ohne_preis, 1);
  assertEquals(b09.orders!.einheiten, 4);
});

// --- Listing-Aggregation: mehrere Angebote je ASIN ---
Deno.test("gezielt angefragter ASIN mit mehreren Listings wird aggregiert", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle(), { asin: "B0DPKD6PVB" });
  assertEquals(r.produkte.length, 1);
  const p = r.produkte[0];
  assertEquals(p.listing!.angebote, 2);
  assertEquals(p.listing!.aktiv, 1);
  assertEquals(p.listing!.preis_min, 9.99);
  assertEquals(p.listing!.preis_max, 10.99);
  // Bestand 0 + ein aktives Angebot → Out-of-Stock-Hinweis.
  assertEquals(p.listing!.bestand_merchant, 0);
  assertEquals(typeof p.hinweise.find((h) => h.includes("Out of Stock")), "string");
});

// --- Basis-Menge: nur aktive ASINs, nicht alle 1500 Listings ---
Deno.test("ohne asin-Filter nur ASINs mit Traffic oder Verkauf", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  // 3 aus S&T + 2 nur-Orders = 5. B0DPKD6PVB (nur Listing) NICHT dabei.
  const asins = r.produkte.map((p) => p.asin).sort();
  assertEquals(asins, ["B00CD2X6QS", "B09JSHP49L", "B0DGTQJTPD", "B0DNT2FDN9", "B0DW43MJC9"]);
});

Deno.test("Sortierung nach S&T-Umsatz", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle());
  // B0DGTQJTPD (65.94) vor B0DNT2FDN9 (48.12) vor dem Rest.
  assertEquals(r.produkte[0].asin, "B0DGTQJTPD");
  assertEquals(r.produkte[1].asin, "B0DNT2FDN9");
});

Deno.test("limit greift", () => {
  const r = baueProductPerformance(salesQuelle(), ordersQuelle(), listingsQuelle(), { limit: 2 });
  assertEquals(r.produkte.length, 2);
});

// --- Robustheit: fehlende Quellen ---
Deno.test("fehlende Quellen kippen nicht um", () => {
  const r = baueProductPerformance(null, null, null);
  assertEquals(r.produkte, []);
  assertEquals(r.quellen.sales_traffic.vorhanden, false);
  assertEquals(r.quellen.orders.vorhanden, false);
});

Deno.test("nur Listings, gezielter ASIN funktioniert ohne S&T/Orders", () => {
  const r = baueProductPerformance(null, null, listingsQuelle(), { asin: "B00CD2X6QS" });
  assertEquals(r.produkte.length, 1);
  assertEquals(r.produkte[0].sales_traffic, null);
  assertEquals(r.produkte[0].orders, null);
  assertEquals(r.produkte[0].listing!.aktiv, 1);
});

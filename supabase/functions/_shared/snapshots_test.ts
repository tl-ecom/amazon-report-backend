import { assertEquals } from "jsr:@std/assert@1";
import { baueAsinRows, baueAsinSnapshotRows } from "./snapshots.ts";

const T = "11111111-1111-1111-1111-111111111111";

// Merchant aktiv mit Bestand 0 (echt ausverkauft), FBA aktiv mit LEERER Menge
// (unbekannt, NICHT 0), Merchant mit Bestand.
const payload = {
  format: "tsv",
  rows: [
    { "seller-sku": "SKU-M0", "asin1": "B0MERCH0", "status": "Active", "fulfillment-channel": "DEFAULT", "price": "19.99", "quantity": "0", "item-name": "Merchant ausverkauft" },
    { "seller-sku": "SKU-FBA", "asin1": "B0FBA000", "status": "Active", "fulfillment-channel": "AMAZON_EU", "price": "29,99", "quantity": "", "item-name": "FBA Angebot" },
    { "seller-sku": "SKU-M5", "asin1": "B0MERCH5", "status": "Active", "fulfillment-channel": "DEFAULT", "price": "9.50", "quantity": "5", "item-name": "Merchant mit Bestand" },
  ],
};

Deno.test("Snapshot: FBA-Menge bleibt null (unbekannt), Merchant-0 bleibt 0", () => {
  const rows = baueAsinSnapshotRows(T, payload, "2026-07-28T10:00:00.000Z", "REP1");
  const bySku = Object.fromEntries(rows.map((r: any) => [r.seller_sku, r]));

  assertEquals(bySku["SKU-M0"].quantity, 0); // echt ausverkauft
  assertEquals(bySku["SKU-M0"].is_fba, false);
  assertEquals(bySku["SKU-FBA"].quantity, null); // LEER -> unbekannt, nicht 0
  assertEquals(bySku["SKU-FBA"].is_fba, true);
  assertEquals(bySku["SKU-FBA"].price, 29.99); // Komma-Dezimal toleriert
  assertEquals(bySku["SKU-M5"].quantity, 5);
  assertEquals(bySku["SKU-M0"].snapshot_date, "2026-07-28");
});

Deno.test("Snapshot: asins werden distinct je ASIN gebaut", () => {
  const asins = baueAsinRows(T, "A1PA6795UKMFR9", payload);
  assertEquals(asins.length, 3);
  assertEquals((asins[0] as any).marketplace_id, "A1PA6795UKMFR9");
});

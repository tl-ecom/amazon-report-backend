import { assertEquals } from "jsr:@std/assert@1";
import { baueFbaBestandRows, baueFbaReturnsRows, baueLedgerAdjustmentsRows, baueReimbursementsRows } from "./history.ts";

Deno.test("baueFbaReturnsRows: mappt FBA-Spalten auf returns_history", () => {
  const payload = {
    rows: [
      {
        "return-date": "2026-06-15T10:00:00Z",
        "order-id": "302-123",
        "sku": "CX10036",
        "asin": "B0D7D2NMT4",
        "product-name": "Celexqua Biomülleimer",
        "quantity": "2",
        "detailed-disposition": "SELLABLE",
        "reason": "UNWANTED_ITEM",
        "status": "Reimbursed",
        "customer-comments": "war doch zu klein",
      },
    ],
  };
  const rows = baueFbaReturnsRows("t1", payload) as any[];
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.tenant_id, "t1");
  assertEquals(r.return_request_date, "2026-06-15");
  assertEquals(r.asin, "B0D7D2NMT4");
  assertEquals(r.sku, "CX10036");
  assertEquals(r.item_name, "Celexqua Biomülleimer");
  assertEquals(r.return_quantity, 2);
  assertEquals(r.return_reason, "UNWANTED_ITEM");
  assertEquals(r.resolution, "SELLABLE");
  assertEquals(r.return_status, "Reimbursed");
  assertEquals(r.refunded_cents, null);
});

Deno.test("baueFbaReturnsRows: quantity fehlt -> mind. 1; leerer/kaputter Payload", () => {
  const rows = baueFbaReturnsRows("t1", { rows: [{ "return-date": "2026-06-01", "asin": "B01" }] }) as any[];
  assertEquals(rows[0].return_quantity, 1);
  assertEquals(baueFbaReturnsRows("t1", null).length, 0);
  assertEquals(baueFbaReturnsRows("t1", {}).length, 0);
});

Deno.test("baueFbaReturnsRows: dedupliziert identische Zeilen per Hash", () => {
  const row = { "return-date": "2026-06-01", "asin": "B01", "quantity": "1" };
  const rows = baueFbaReturnsRows("t1", { rows: [row, { ...row }] }) as any[];
  assertEquals(rows.length, 1);
});

Deno.test("baueReimbursementsRows: mappt Reimbursement-Spalten", () => {
  const payload = { rows: [{
    "approval-date": "2026-06-10", "reimbursement-id": "R1", "case-id": "C1",
    "reason": "Damaged:Warehouse", "sku": "CX1", "fnsku": "X0", "asin": "B01",
    "product-name": "Testartikel", "condition": "SELLABLE", "currency-unit": "EUR",
    "amount-total": "12,50", "quantity-reimbursed-total": "2",
    "quantity-reimbursed-cash": "2", "quantity-reimbursed-inventory": "0",
  }] };
  const rows = baueReimbursementsRows("t1", payload) as any[];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].asin, "B01");
  assertEquals(rows[0].reason, "Damaged:Warehouse");
  assertEquals(rows[0].amount_total_cents, 1250);
  assertEquals(rows[0].quantity_total, 2);
});

Deno.test("baueLedgerAdjustmentsRows: nur Adjustments, signierte Menge", () => {
  const payload = { rows: [
    { "Date": "2026-06-01", "Event Type": "Adjustments", "ASIN": "B01", "MSKU": "CX1", "FNSKU": "X0", "Title": "A", "Reference ID": "REF1", "Quantity": "-3", "Reason": "M", "Disposition": "SELLABLE", "Fulfillment Center": "DE1", "Country": "DE" },
    { "Date": "2026-06-02", "Event Type": "Shipments", "ASIN": "B02", "Quantity": "-5" },
    { "Date": "2026-06-03", "Event Type": "Adjustments", "ASIN": "B03", "Quantity": "2", "Reason": "F" },
  ] };
  const rows = baueLedgerAdjustmentsRows("t1", payload) as any[];
  assertEquals(rows.length, 2); // Shipments übersprungen
  const b01 = rows.find((r) => r.asin === "B01");
  assertEquals(b01.quantity, -3);
  assertEquals(b01.reason, "M");
  assertEquals(rows.find((r) => r.asin === "B03").quantity, 2);
});

Deno.test("baueReimbursementsRows: leerer Payload -> []", () => {
  assertEquals(baueReimbursementsRows("t1", null).length, 0);
  assertEquals(baueLedgerAdjustmentsRows("t1", {}).length, 0);
});

Deno.test("baueLedgerAdjustmentsRows: gequotete Header UND Werte (Ledger-Report)", () => {
  const payload = { rows: [{
    '"Date"': '"2026-06-05"', '"Event Type"': '"Adjustments"', '"ASIN"': '"B0X"',
    '"MSKU"': '"CX9"', '"Quantity"': '"-4"', '"Reason"': '"M"', '"Disposition"': '"SELLABLE"',
  }] };
  const rows = baueLedgerAdjustmentsRows("t1", payload) as any[];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].asin, "B0X");
  assertEquals(rows[0].quantity, -4);
  assertEquals(rows[0].reason, "M");
  assertEquals(rows[0].sku, "CX9");
});

Deno.test("baueFbaBestandRows: echte Bestandsmengen inkl. Nachschub unterwegs", () => {
  // Echte Zeile aus dem Vaneja-Report (Koch Chemie): 0 verkaufsfaehig, 75 unterwegs.
  const payload = { rows: [{
    "sku": "18-Y92L-D87T", "asin": "B0H15QMFP1", "fnsku": "B0H15QMFP1",
    "product-name": "Koch Chemie Mzr Mehrzweckreiniger", "your-price": "28.97",
    "afn-fulfillable-quantity": "0", "afn-total-quantity": "77",
    "afn-reserved-quantity": "0", "afn-unsellable-quantity": "0",
    "afn-warehouse-quantity": "2", "afn-researching-quantity": "2",
    "afn-inbound-shipped-quantity": "75", "afn-inbound-working-quantity": "0",
    "afn-inbound-receiving-quantity": "0", "mfn-fulfillable-quantity": "",
    "afn-listing-exists": "Yes", "mfn-listing-exists": "No",
  }] };
  const rows = baueFbaBestandRows("t1", payload) as any[];
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.asin, "B0H15QMFP1");
  assertEquals(r.verkaufsfaehig, 0);      // echte 0 bleibt 0
  assertEquals(r.gesamt, 77);
  assertEquals(r.inbound_shipped, 75);    // Nachschub unterwegs
  assertEquals(r.preis_cents, 2897);
  assertEquals(r.afn_listing, true);
  assertEquals(r.mfn_listing, false);
  assertEquals(r.mfn_verkaufsfaehig, null); // LEER -> unbekannt, NICHT 0
});

Deno.test("baueFbaBestandRows: ohne SKU wird uebersprungen; leerer Payload -> []", () => {
  assertEquals(baueFbaBestandRows("t1", { rows: [{ asin: "B01" }] }).length, 0);
  assertEquals(baueFbaBestandRows("t1", null).length, 0);
});

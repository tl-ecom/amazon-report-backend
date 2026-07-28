import { assertEquals } from "jsr:@std/assert@1";
import { baueFbaReturnsRows } from "./history.ts";

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

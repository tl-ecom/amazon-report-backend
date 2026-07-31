import { assertEquals } from "jsr:@std/assert@1";
import {
  baueFbaBestandRows, baueFbaReturnsRows, baueGebuehrenvorschauRows,
  baueLedgerAdjustmentsRows, baueReimbursementsRows, baueSettlementRows,
  datumOderNull, gewichtG, laengeCm,
} from "./history.ts";

Deno.test("laengeCm: normalisiert cm/mm/Zoll, unbekannte Einheit -> null", () => {
  assertEquals(laengeCm("31.5", "centimeters"), 31.5);
  assertEquals(laengeCm("31,5", "cm"), 31.5); // Komma-Dezimal
  assertEquals(laengeCm("315", "millimeters"), 31.5);
  assertEquals(laengeCm("10", "inches"), 25.4);
  assertEquals(laengeCm("31.5", ""), 31.5); // ohne Einheit: cm annehmen (Report-Standard DE)
  // Lieber KEIN Wert als ein falscher: unbekannte Einheit -> unbekannt.
  assertEquals(laengeCm("10", "furlongs"), null);
  assertEquals(laengeCm("", "cm"), null);
  assertEquals(laengeCm("--", "cm"), null);
});

Deno.test("gewichtG: normalisiert kg/g/lb, unbekannte Einheit -> null", () => {
  assertEquals(gewichtG("1.2", "kilograms"), 1200);
  assertEquals(gewichtG("1.2", ""), 1200); // Report liefert DE in kg
  assertEquals(gewichtG("850", "grams"), 850);
  assertEquals(Math.round(gewichtG("2", "pounds") as number), 907);
  assertEquals(gewichtG("2", "stone"), null);
  assertEquals(gewichtG("", "kg"), null);
});

Deno.test("baueGebuehrenvorschauRows: uebernimmt Amazons Groessenklasse unveraendert", () => {
  const rows = baueGebuehrenvorschauRows("t1", {
    rows: [{
      "sku": "VAN-001", "asin": "B0ABC", "product-name": "Obst Etagere",
      "brand": "Vaneja", "fulfilled-by": "AMAZON_EU", "has-local-inventory": "Yes",
      "your-price": "29.99", "sales-price": "27.99", "currency": "EUR",
      "longest-side": "31.5", "median-side": "20.0", "shortest-side": "10.2",
      "length-and-girth": "92.0", "unit-of-dimension": "centimeters",
      "item-package-weight": "1.2", "unit-of-weight": "kilograms",
      "product-size-weight-band": "Standard-Umschlag",
      "estimated-fee-total": "8.42", "estimated-referral-fee-per-unit": "4.50",
      "estimated-variable-closing-fee": "", "expected-domestic-fulfilment-fee-per-unit": "3.92",
    }],
  }) as any[];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].groessenklasse, "Standard-Umschlag"); // NICHT selbst abgeleitet
  assertEquals(rows[0].laengste_seite_cm, 31.5);
  assertEquals(rows[0].gewicht_g, 1200);
  assertEquals(rows[0].gebuehr_gesamt_cents, 842);
  assertEquals(rows[0].fulfilment_cents, 392);
  assertEquals(rows[0].closing_cents, null); // leer bleibt unbekannt, nicht 0
});

Deno.test("baueGebuehrenvorschauRows: gleiche SKU je Marktplatz bleibt getrennt", () => {
  // Der Report fuehrt dieselbe SKU einmal je Store. Ohne Marktplatz im Schluessel
  // wuerden franzoesische Gebuehren die deutschen ueberschreiben.
  const rows = baueGebuehrenvorschauRows("t1", {
    rows: [
      { "sku": "VAN 001", "amazon-store": "DE", "expected-domestic-fulfilment-fee-per-unit": "3.92" },
      { "sku": "VAN 001", "amazon-store": "FR", "expected-domestic-fulfilment-fee-per-unit": "5.10" },
    ],
  }) as any[];
  assertEquals(rows.length, 2);
  assertEquals(rows.find((r) => r.marketplace === "DE").fulfilment_cents, 392);
  assertEquals(rows.find((r) => r.marketplace === "FR").fulfilment_cents, 510);
});

Deno.test("baueGebuehrenvorschauRows: ohne Store-Spalte -> DE", () => {
  const rows = baueGebuehrenvorschauRows("t1", { rows: [{ sku: "A" }] }) as any[];
  assertEquals(rows[0].marketplace, "DE");
});

Deno.test("baueGebuehrenvorschauRows: ohne SKU wird uebersprungen; leer -> []", () => {
  assertEquals(baueGebuehrenvorschauRows("t1", { rows: [{ asin: "B01" }] }).length, 0);
  assertEquals(baueGebuehrenvorschauRows("t1", {}).length, 0);
});

Deno.test("datumOderNull: TT.MM.JJJJ wird NICHT als US-Datum gelesen", () => {
  // Der Fehler, der im Abrechnungsbericht auffiel: new Date("05.06.2026")
  // liefert in V8 den 6. Mai. Amazon meint aber den 5. Juni.
  assertEquals(datumOderNull("05.06.2026"), "2026-06-05");
  assertEquals(datumOderNull("31.12.2026"), "2026-12-31"); // als US-Datum unmoeglich
  assertEquals(datumOderNull("1.7.2026"), "2026-07-01");   // ohne fuehrende Null
  assertEquals(datumOderNull("2026-06-05"), "2026-06-05");
  assertEquals(datumOderNull("2026-06-05T12:30:00Z"), "2026-06-05");
  assertEquals(datumOderNull("05.13.2026"), null);         // Monat 13 gibt es nicht
  assertEquals(datumOderNull(""), null);
  assertEquals(datumOderNull("keine Ahnung"), null);
});

Deno.test("baueSettlementRows: normalisiert ohne zu interpretieren", () => {
  const rows = baueSettlementRows("t1", {
    rows: [
      // Kopfzeile: nur Zeitraum und Auszahlungssumme, kein Betragstyp.
      {
        "settlement-id": "301", "settlement-start-date": "2026-07-01",
        "settlement-end-date": "2026-07-14", "deposit-date": "2026-07-16",
        "total-amount": "12345.67", "currency": "EUR",
      },
      {
        "settlement-id": "301", "transaction-type": "Order", "order-id": "302-1",
        "amount-type": "ItemFees", "amount-description": "FBAPerUnitFulfillmentFee",
        "amount": "-4.43", "posted-date": "2026-07-03", "sku": "BIO001",
        "quantity-purchased": "1", "marketplace-name": "amazon.de",
      },
    ],
  }) as any[];
  assertEquals(rows.length, 2);
  const kopf = rows.find((r) => r.betrag_typ === null);
  assertEquals(kopf.gesamtbetrag_cents, 1234567);
  assertEquals(kopf.auszahlung_datum, "2026-07-16");
  const zeile = rows.find((r) => r.betrag_typ === "ItemFees");
  // Beschreibung UNVERAENDERT — die Auswertung passiert nicht hier.
  assertEquals(zeile.betrag_beschreibung, "FBAPerUnitFulfillmentFee");
  assertEquals(zeile.betrag_cents, -443);
  assertEquals(zeile.sku, "BIO001");
  assertEquals(zeile.menge, 1);
});

Deno.test("baueSettlementRows: dedupliziert identische Zeilen, leer -> []", () => {
  const doppelt = { "settlement-id": "9", "amount": "-1.00", "amount-type": "ItemFees" };
  assertEquals(baueSettlementRows("t1", { rows: [doppelt, { ...doppelt }] }).length, 1);
  assertEquals(baueSettlementRows("t1", {}).length, 0);
});

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

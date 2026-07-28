import { assertEquals } from "jsr:@std/assert@1";
import { akkuZuZeilen, monatAusDatum, verarbeiteFinancialEvents } from "./finances.ts";

Deno.test("monatAusDatum: ISO -> YYYY-MM, Müll -> null", () => {
  assertEquals(monatAusDatum("2026-06-13T10:00:00Z"), "2026-06");
  assertEquals(monatAusDatum(""), null);
  assertEquals(monatAusDatum(undefined), null);
});

Deno.test("ShipmentEvent: FBA + Referral-Gebühren werden je Monat summiert", () => {
  const events = {
    ShipmentEventList: [
      {
        PostedDate: "2026-06-10T12:00:00Z",
        ShipmentItemList: [
          {
            SellerSKU: "SKU1",
            ItemFeeList: [
              { FeeType: "Commission", FeeAmount: { CurrencyAmount: -2.5, CurrencyCode: "EUR" } },
              { FeeType: "FBAPerUnitFulfillmentFee", FeeAmount: { CurrencyAmount: -3.1, CurrencyCode: "EUR" } },
            ],
          },
        ],
      },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteFinancialEvents(events, akku);
  assertEquals(akku.get("2026-06"), -5.6);
});

Deno.test("RefundEvent (andere Monat) + Erstattung (positiv) getrennt gebucht", () => {
  const events = {
    RefundEventList: [
      {
        PostedDate: "2026-05-20T00:00:00Z",
        ShipmentItemAdjustmentList: [
          { ItemFeeAdjustmentList: [{ FeeType: "RefundCommission", FeeAmount: { CurrencyAmount: -0.6, CurrencyCode: "EUR" } }] },
          { ItemFeeAdjustmentList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: 1.2, CurrencyCode: "EUR" } }] },
        ],
      },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteFinancialEvents(events, akku);
  assertEquals(akku.get("2026-05"), 0.6); // -0.6 + 1.2
});

Deno.test("Event ohne PostedDate wird übersprungen", () => {
  const events = {
    ServiceFeeEventList: [
      { FeeReason: "FBAInboundTransportationFee", FeeList: [{ FeeType: "x", FeeAmount: { CurrencyAmount: -9.9, CurrencyCode: "EUR" } }] },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteFinancialEvents(events, akku);
  assertEquals(akku.size, 0);
});

Deno.test("mehrere Seiten summieren in denselben Akku", () => {
  const akku = new Map<string, number>();
  verarbeiteFinancialEvents({ ShipmentEventList: [{ PostedDate: "2026-06-01", ShipmentItemList: [{ ItemFeeList: [{ FeeAmount: { CurrencyAmount: -1 } }] }] }] }, akku);
  verarbeiteFinancialEvents({ ShipmentEventList: [{ PostedDate: "2026-06-15", ShipmentItemList: [{ ItemFeeList: [{ FeeAmount: { CurrencyAmount: -2 } }] }] }] }, akku);
  assertEquals(akku.get("2026-06"), -3);
});

Deno.test("akkuZuZeilen: signierte Cents, aufsteigend sortiert", () => {
  const akku = new Map<string, number>([["2026-06", -5.6], ["2026-05", -1.23]]);
  assertEquals(akkuZuZeilen(akku), [
    { monat: "2026-05", gebuehren_cents: -123 },
    { monat: "2026-06", gebuehren_cents: -560 },
  ]);
});

Deno.test("leere/kaputte Eingabe kippt nicht um", () => {
  const akku = new Map<string, number>();
  verarbeiteFinancialEvents(null, akku);
  verarbeiteFinancialEvents({}, akku);
  verarbeiteFinancialEvents({ Foo: "bar" }, akku);
  assertEquals(akku.size, 0);
});

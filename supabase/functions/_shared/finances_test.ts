import { assertEquals } from "jsr:@std/assert@1";
import {
  akkuZuZeilen, detailZuZeilen, monatAusDatum,
  verarbeiteFinancialEvents, verarbeiteGebuehrenDetail,
} from "./finances.ts";

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

// --- Gebuehren je SKU und Art -----------------------------------------------

const SHIPMENT = {
  ShipmentEventList: [
    {
      PostedDate: "2026-06-10T12:00:00Z",
      AmazonOrderId: "302-1",
      ShipmentItemList: [
        {
          SellerSKU: "SKU1",
          ItemFeeList: [
            { FeeType: "Commission", FeeAmount: { CurrencyAmount: -2.5, CurrencyCode: "EUR" } },
            { FeeType: "FBAPerUnitFulfillmentFee", FeeAmount: { CurrencyAmount: -3.1, CurrencyCode: "EUR" } },
          ],
        },
        {
          SellerSKU: "SKU2",
          ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -1.0, CurrencyCode: "EUR" } }],
        },
      ],
    },
  ],
};

Deno.test("Detail: Gebuehren je SKU UND Art getrennt", () => {
  const akku = new Map<string, number>();
  verarbeiteGebuehrenDetail(SHIPMENT, akku);
  const z = detailZuZeilen(akku);
  assertEquals(z.length, 3);
  const sku1 = z.filter((x) => x.sku === "SKU1");
  assertEquals(sku1.length, 2);
  assertEquals(sku1.find((x) => x.fee_typ === "Commission")?.betrag_cents, -250);
  assertEquals(sku1.find((x) => x.fee_typ === "FBAPerUnitFulfillmentFee")?.betrag_cents, -310);
  assertEquals(z.find((x) => x.sku === "SKU2")?.betrag_cents, -100);
});

Deno.test("Detail: Summe stimmt mit der Monatssumme ueberein", () => {
  const monat = new Map<string, number>();
  verarbeiteFinancialEvents(SHIPMENT, monat);
  const detail = new Map<string, number>();
  verarbeiteGebuehrenDetail(SHIPMENT, detail);
  const summeDetail = detailZuZeilen(detail).reduce((s, x) => s + x.betrag_cents, 0);
  assertEquals(summeDetail, Math.round((monat.get("2026-06") ?? 0) * 100));
});

Deno.test("Detail: gleiche SKU+Art in mehreren Posten wird addiert", () => {
  const events = {
    ShipmentEventList: [
      { PostedDate: "2026-06-01T00:00:00Z", ShipmentItemList: [{ SellerSKU: "A", ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -1 } }] }] },
      { PostedDate: "2026-06-20T00:00:00Z", ShipmentItemList: [{ SellerSKU: "A", ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -2 } }] }] },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteGebuehrenDetail(events, akku);
  const z = detailZuZeilen(akku);
  assertEquals(z.length, 1);
  assertEquals(z[0].betrag_cents, -300);
});

Deno.test("Detail: Gebuehr ohne SKU (Order-/Service-Level) geht NICHT verloren", () => {
  const events = {
    ServiceFeeEventList: [
      { PostedDate: "2026-07-05T00:00:00Z", FeeReason: "Lagergebuehr",
        FeeList: [{ FeeType: "FBAStorageFee", FeeAmount: { CurrencyAmount: -12.34 } }] },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteGebuehrenDetail(events, akku);
  const z = detailZuZeilen(akku);
  assertEquals(z.length, 1);
  assertEquals(z[0].sku, null); // nicht produktscharf zuordenbar — aber gezaehlt
  assertEquals(z[0].fee_typ, "FBAStorageFee");
  assertEquals(z[0].betrag_cents, -1234);
});

Deno.test("Detail: SKU vererbt sich nach unten, Monate bleiben getrennt", () => {
  const events = {
    ShipmentEventList: [
      { PostedDate: "2026-05-31T00:00:00Z", ShipmentItemList: [{ SellerSKU: "X", ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -5 } }] }] },
      { PostedDate: "2026-06-01T00:00:00Z", ShipmentItemList: [{ SellerSKU: "X", ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -7 } }] }] },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteGebuehrenDetail(events, akku);
  const z = detailZuZeilen(akku);
  assertEquals(z.length, 2);
  assertEquals(z.find((x) => x.monat === "2026-05")?.betrag_cents, -500);
  assertEquals(z.find((x) => x.monat === "2026-06")?.betrag_cents, -700);
});

Deno.test("Detail: SKU mit Leerzeichen bleibt intakt (Schluessel-Trennung)", () => {
  const events = {
    ShipmentEventList: [
      { PostedDate: "2026-06-01T00:00:00Z",
        ShipmentItemList: [{ SellerSKU: "MEIN SKU 42", ItemFeeList: [{ FeeType: "Fee Type Mit Leerzeichen", FeeAmount: { CurrencyAmount: -9 } }] }] },
    ],
  };
  const akku = new Map<string, number>();
  verarbeiteGebuehrenDetail(events, akku);
  const z = detailZuZeilen(akku);
  assertEquals(z[0].sku, "MEIN SKU 42");
  assertEquals(z[0].fee_typ, "Fee Type Mit Leerzeichen");
});

Deno.test("Detail: leere/kaputte Eingabe kippt nicht um", () => {
  const akku = new Map<string, number>();
  verarbeiteGebuehrenDetail(null, akku);
  verarbeiteGebuehrenDetail({}, akku);
  verarbeiteGebuehrenDetail({ Liste: "kein Array" }, akku);
  assertEquals(detailZuZeilen(akku).length, 0);
});

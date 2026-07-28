// Tests für listings.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import { baueListingsOverview } from "./listings.ts";

function angebot(o: {
  status?: string;
  channel?: string;
  quantity?: string;
  price?: string;
  sku?: string;
  asin?: string;
  name?: string;
}): Record<string, string> {
  return {
    status: o.status ?? "Active",
    "fulfillment-channel": o.channel ?? "DEFAULT",
    quantity: o.quantity ?? "",
    price: o.price ?? "",
    "seller-sku": o.sku ?? "SKU-1",
    asin1: o.asin ?? "B001",
    "item-name": o.name ?? "Artikel",
  };
}

const ts = "2026-07-17T00:00:00Z";
const payload = (rows: Record<string, string>[]) => ({ format: "tsv", rows });

// --- DER Kern: quantity je Channel verschieden interpretieren ---
Deno.test("aktives Merchant-Angebot mit quantity=0 zaehlt als ausverkauft", () => {
  const o = baueListingsOverview(
    payload([angebot({ channel: "DEFAULT", quantity: "0", sku: "LEER-1", asin: "B0X" })]),
    ts
  );
  assertEquals(o.bestand_merchant.ausverkauft, 1);
  assertEquals(o.bestand_merchant.ausverkaufte_skus[0].sku, "LEER-1");
  assertEquals(typeof o.warnungen.find((w) => w.includes("Out-of-Stock")), "string");
});

Deno.test("aktives FBA-Angebot mit leerer quantity ist NICHT ausverkauft", () => {
  // Genau der reale Fall: FBA führt den Bestand nicht in diesem Report.
  const o = baueListingsOverview(
    payload([angebot({ channel: "AMAZON_EU", quantity: "" })]),
    ts
  );
  assertEquals(o.bestand_merchant.ausverkauft, 0); // NICHT als Out-of-Stock werten
  assertEquals(o.bestand_fba.aktive_angebote, 1);
  assertEquals(o.bestand_fba.menge_hier_nicht_gefuehrt, 1);
  assertEquals(o.aktive_nach_fulfillment.fba, 1);
  assertEquals(o.aktive_nach_fulfillment.merchant, 0);
});

Deno.test("FBA-Angebot mit quantity=0 wird trotzdem nicht als Merchant-Ausverkauf gezaehlt", () => {
  // Falls Amazon bei FBA doch mal eine 0 liefert: es bleibt FBA, kein Merchant-Alarm.
  const o = baueListingsOverview(payload([angebot({ channel: "AMAZON_NA", quantity: "0" })]), ts);
  assertEquals(o.bestand_merchant.ausverkauft, 0);
  assertEquals(o.bestand_fba.aktive_angebote, 1);
});

// --- Status ---
Deno.test("Status wird korrekt gezaehlt", () => {
  const o = baueListingsOverview(
    payload([
      angebot({ status: "Active" }),
      angebot({ status: "Inactive" }),
      angebot({ status: "Inactive" }),
      angebot({ status: "Incomplete" }),
    ]),
    ts
  );
  assertEquals(o.gesamt.angebote, 4);
  assertEquals(o.gesamt.aktiv, 1);
  assertEquals(o.gesamt.inaktiv, 2);
  assertEquals(o.gesamt.unvollstaendig, 1);
});

Deno.test("inaktive Angebote zaehlen nicht in Bestand/Fulfillment", () => {
  const o = baueListingsOverview(
    payload([angebot({ status: "Inactive", channel: "DEFAULT", quantity: "0" })]),
    ts
  );
  // Inaktiv + quantity 0 ist KEIN Out-of-Stock-Alarm (das Angebot ist ohnehin aus).
  assertEquals(o.bestand_merchant.ausverkauft, 0);
  assertEquals(o.aktive_nach_fulfillment.merchant, 0);
});

// --- Bestandssumme (nur Merchant) ---
Deno.test("Merchant-Einheiten werden summiert, FBA nicht", () => {
  const o = baueListingsOverview(
    payload([
      angebot({ channel: "DEFAULT", quantity: "13" }),
      angebot({ channel: "DEFAULT", quantity: "7" }),
      angebot({ channel: "AMAZON_EU", quantity: "" }), // zählt nicht in Einheiten
    ]),
    ts
  );
  assertEquals(o.bestand_merchant.einheiten_gesamt, 20);
  assertEquals(o.bestand_merchant.aktive_angebote, 2);
  assertEquals(o.bestand_fba.aktive_angebote, 1);
});

// --- Preise ---
Deno.test("Preisspanne und Median der aktiven Angebote", () => {
  const o = baueListingsOverview(
    payload([
      angebot({ price: "3.95" }),
      angebot({ price: "10.00" }),
      angebot({ price: "7.00" }),
      angebot({ price: "" }), // ohne Preis
    ]),
    ts
  );
  assertEquals(o.preis_aktiv.min, 3.95);
  assertEquals(o.preis_aktiv.max, 10);
  assertEquals(o.preis_aktiv.median, 7);
  assertEquals(o.preis_aktiv.ohne_preis, 1);
});

Deno.test("Median bei gerader Anzahl mittelt die beiden mittleren", () => {
  const o = baueListingsOverview(
    payload([angebot({ price: "2" }), angebot({ price: "4" }), angebot({ price: "6" }), angebot({ price: "8" })]),
    ts
  );
  assertEquals(o.preis_aktiv.median, 5); // (4+6)/2
});

// --- Robustheit ---
Deno.test("leerer Report kippt nicht um", () => {
  const o = baueListingsOverview(payload([]), ts);
  assertEquals(o.gesamt.angebote, 0);
  assertEquals(o.bestand_merchant.ausverkauft, 0);
  assertEquals(o.preis_aktiv.min, null);
  assertEquals(o.warnungen, []);
});

Deno.test("payload ohne rows kippt nicht um", () => {
  const o = baueListingsOverview({}, ts);
  assertEquals(o.gesamt.angebote, 0);
});

// --- Der reale Datensatz vom 2026-07-17 (Verteilungen) ---
Deno.test("realistische Mischung ergibt die erwarteten Kategorien", () => {
  const rows = [
    ...Array.from({ length: 471 }, (_, i) => angebot({ channel: "DEFAULT", quantity: String(i % 20 + 1), price: "5.00" })),
    ...Array.from({ length: 4 }, () => angebot({ channel: "AMAZON_EU", quantity: "" })),
    ...Array.from({ length: 1106 }, () => angebot({ status: "Inactive" })),
    ...Array.from({ length: 35 }, () => angebot({ status: "Incomplete" })),
  ];
  const o = baueListingsOverview(payload(rows), ts);

  assertEquals(o.gesamt.angebote, 1616);
  assertEquals(o.gesamt.aktiv, 475);
  assertEquals(o.gesamt.inaktiv, 1106);
  assertEquals(o.gesamt.unvollstaendig, 35);
  assertEquals(o.aktive_nach_fulfillment.merchant, 471);
  assertEquals(o.aktive_nach_fulfillment.fba, 4);
  assertEquals(o.bestand_merchant.ausverkauft, 0); // keiner mit quantity 0 in dieser Mischung
  assertEquals(o.bestand_fba.menge_hier_nicht_gefuehrt, 4);
  // FBA-Warnung muss da sein, Out-of-Stock-Warnung nicht.
  assertEquals(o.warnungen.length, 1);
  assertEquals(o.warnungen[0].includes("FBA"), true);
});

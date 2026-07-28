// Tests für ads.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Fixtures synthetisch: die Ads-API kann ohne Advertising-Credentials nicht scharf
// abgefragt werden. Die Zeilenstruktur entspricht der v3-Spec (spAdvertisedProduct).

import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { baueAdsOverview, baueSpReportRequest, istVorlaeufig, VOLATIL_TAGE, ymd } from "./ads.ts";

function zeile(o: {
  date?: string;
  campaignId?: string;
  campaignName?: string;
  asin?: string;
  impressions?: number;
  clicks?: number;
  cost?: number;
  sales?: number;
  orders?: number;
  units?: number;
}): Record<string, any> {
  return {
    date: o.date ?? "2026-07-01",
    campaignId: o.campaignId ?? "C1",
    campaignName: o.campaignName ?? "Kampagne 1",
    advertisedAsin: o.asin ?? "B001",
    impressions: o.impressions ?? 0,
    clicks: o.clicks ?? 0,
    cost: o.cost ?? 0,
    sales7d: o.sales ?? 0,
    purchases7d: o.orders ?? 0,
    unitsSoldClicks7d: o.units ?? 0,
  };
}

const ts = "2026-07-17T00:00:00Z";

// --- Report-Request ---
Deno.test("baueSpReportRequest erzeugt eine v3-konforme Anfrage", () => {
  const r = baueSpReportRequest("2026-07-01", "2026-07-14");
  assertEquals(r.configuration.adProduct, "SPONSORED_PRODUCTS");
  assertEquals(r.configuration.reportTypeId, "spAdvertisedProduct");
  assertEquals(r.configuration.format, "GZIP_JSON");
  assertEquals(r.startDate, "2026-07-01");
  assertEquals(r.configuration.columns.includes("cost"), true);
  assertEquals(r.configuration.columns.includes("sales7d"), true);
});

Deno.test("ymd formatiert als YYYY-MM-DD", () => {
  assertEquals(ymd(new Date("2026-07-05T13:22:00Z")), "2026-07-05");
});

// --- 72h-Vorläufigkeit ---
Deno.test("Enddatum innerhalb der letzten 3 Tage ist vorlaeufig", () => {
  const heute = new Date("2026-07-17T12:00:00Z");
  assertEquals(istVorlaeufig("2026-07-17", heute), true); // heute
  assertEquals(istVorlaeufig("2026-07-16", heute), true); // gestern
  assertEquals(istVorlaeufig("2026-07-15", heute), true); // vorgestern
});

Deno.test("Enddatum aelter als 3 Tage ist stabil", () => {
  const heute = new Date("2026-07-17T12:00:00Z");
  assertEquals(istVorlaeufig("2026-07-14", heute), false);
  assertEquals(istVorlaeufig("2026-06-30", heute), false);
});

Deno.test("VOLATIL_TAGE ist 3 (die dokumentierten 72h)", () => {
  assertEquals(VOLATIL_TAGE, 3);
});

// --- DER Kern: ACOS/ROAS aus Rohwerten ---
Deno.test("ACOS und ROAS werden aus Rohwerten gerechnet", () => {
  // Spend 25, Sales 100 → ACOS 25%, ROAS 4.
  const o = baueAdsOverview([zeile({ cost: 10, sales: 40 }), zeile({ cost: 15, sales: 60 })], ts, false);
  assertEquals(o.gesamt.spend, 25);
  assertEquals(o.gesamt.sales, 100);
  assertEquals(o.gesamt.acos, 25);
  assertEquals(o.gesamt.roas, 4);
});

Deno.test("CTR, CVR, CPC werden korrekt gerechnet", () => {
  // 1000 Impressions, 50 Clicks, 5 Orders, Spend 25.
  const o = baueAdsOverview([zeile({ impressions: 1000, clicks: 50, orders: 5, cost: 25, sales: 100 })], ts, false);
  assertEquals(o.gesamt.ctr, 5); // 50/1000
  assertEquals(o.gesamt.cvr, 10); // 5/50
  assertEquals(o.gesamt.cpc, 0.5); // 25/50
});

// --- Nenner 0 → null, nicht 0/NaN/Infinity ---
Deno.test("ACOS bei Sales 0 ist null (Spend ohne Umsatz)", () => {
  // Klassischer Fall: Geld ausgegeben, kein Umsatz. ACOS ist nicht 0, sondern
  // undefiniert (Division durch 0) — null ist die ehrliche Aussage.
  const o = baueAdsOverview([zeile({ clicks: 10, cost: 5, sales: 0, orders: 0 })], ts, false);
  assertEquals(o.gesamt.spend, 5);
  assertEquals(o.gesamt.sales, 0);
  assertEquals(o.gesamt.acos, null); // NICHT 0
  assertEquals(o.gesamt.roas, 0); // sales/spend = 0/5 = 0 (das ist definiert)
});

Deno.test("CTR/CVR/CPC bei 0 Impressions/Clicks sind null", () => {
  const o = baueAdsOverview([zeile({ impressions: 0, clicks: 0 })], ts, false);
  assertEquals(o.gesamt.ctr, null);
  assertEquals(o.gesamt.cvr, null);
  assertEquals(o.gesamt.cpc, null);
});

// --- Geld driftet nicht ---
Deno.test("Betraege in Cent driften nicht", () => {
  const o = baueAdsOverview([zeile({ cost: 0.1, sales: 0.2 }), zeile({ cost: 0.2, sales: 0.1 })], ts, false);
  assertEquals(o.gesamt.spend, 0.3);
  assertEquals(o.gesamt.sales, 0.3);
});

// --- Gruppierung ---
Deno.test("nach Kampagne und ASIN aufgeschluesselt, nach Spend sortiert", () => {
  const o = baueAdsOverview(
    [
      zeile({ campaignId: "C1", campaignName: "Marke", asin: "B001", cost: 5, sales: 20 }),
      zeile({ campaignId: "C2", campaignName: "Auto", asin: "B002", cost: 15, sales: 30 }),
      zeile({ campaignId: "C1", campaignName: "Marke", asin: "B001", cost: 3, sales: 10 }),
    ],
    ts,
    false
  );
  // C2 hat mehr Spend (15) als C1 (8) → zuerst.
  assertEquals(o.proKampagne[0].campaignId, "C2");
  assertEquals(o.proKampagne[1].campaignId, "C1");
  assertEquals(o.proKampagne[1].spend, 8);
  // ASIN B002 (15) vor B001 (8).
  assertEquals(o.proAsin[0].asin, "B002");
  assertEquals(o.proAsin[0].acos, 50); // 15/30
});

// --- is_provisional wird durchgereicht + gewarnt ---
Deno.test("is_provisional erzeugt eine Warnung", () => {
  const o = baueAdsOverview([zeile({ cost: 5, sales: 20 })], ts, true);
  assertEquals(o.is_provisional, true);
  assertEquals(typeof o.warnungen.find((w) => w.includes("noch angepasst")), "string");
});

// --- Zeitraum aus den Zeilen ---
Deno.test("Zeitraum ist Min/Max der date-Spalte", () => {
  const o = baueAdsOverview(
    [zeile({ date: "2026-07-05" }), zeile({ date: "2026-07-01" }), zeile({ date: "2026-07-10" })],
    ts,
    false
  );
  assertEquals(o.zeitraum, { von: "2026-07-01", bis: "2026-07-10" });
});

// --- Robustheit ---
Deno.test("leerer Report kippt nicht um", () => {
  const o = baueAdsOverview([], ts, false);
  assertEquals(o.gesamt.impressions, 0);
  assertEquals(o.gesamt.acos, null);
  assertEquals(o.proKampagne, []);
  assertEquals(typeof o.warnungen.find((w) => w.includes("Keine Ads-Daten")), "string");
});

Deno.test("fehlende Felder zaehlen als 0, nicht NaN", () => {
  const o = baueAdsOverview([{ campaignId: "C1", advertisedAsin: "B1" }], ts, false);
  assertEquals(o.gesamt.impressions, 0);
  assertEquals(o.gesamt.spend, 0);
});

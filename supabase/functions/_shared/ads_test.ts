// Tests für ads.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Fixtures synthetisch: die Ads-API kann ohne Advertising-Credentials nicht scharf
// abgefragt werden. Die Zeilenstruktur entspricht der v3-Spec (spAdvertisedProduct).

import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { baueAdsDailyRows, baueAdsOverview, baueFenster, baueSpReportRequest, istVorlaeufig, spanneTage, VOLATIL_TAGE, ymd } from "./ads.ts";

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

// --- baueAdsDailyRows (Tagesreihe fuer ads_daily) ---

const T = "11111111-1111-1111-1111-111111111111";

Deno.test("ads_daily: eine Zeile je Tag/Kampagne/ASIN, Geld in Cent", () => {
  const r = baueAdsDailyRows(T, [
    zeile({ date: "2026-07-01", campaignId: "C1", asin: "B001", impressions: 100, clicks: 5, cost: 1.23, sales: 9.99, orders: 1, units: 2 }),
    zeile({ date: "2026-07-02", campaignId: "C1", asin: "B001", impressions: 50 }),
  ]);
  assertEquals(r.length, 2);
  const tag1 = r.find((x) => x.datum === "2026-07-01")!;
  assertEquals(tag1.tenant_id, T);
  assertEquals(tag1.impressions, 100);
  assertEquals(tag1.spend_cents, 123);
  assertEquals(tag1.sales_cents, 999);
  assertEquals(tag1.orders, 1);
  assertEquals(tag1.einheiten, 2);
});

Deno.test("ads_daily: gleicher Schluessel wird summiert, nicht dupliziert", () => {
  // Der Upsert ersetzt die Zeile — doppelte Schluessel muessen vorher zur
  // Tagessumme verschmelzen, sonst ginge einer der Betraege verloren.
  const r = baueAdsDailyRows(T, [
    zeile({ date: "2026-07-01", campaignId: "C1", asin: "B001", clicks: 3, cost: 1.0 }),
    zeile({ date: "2026-07-01", campaignId: "C1", asin: "B001", clicks: 4, cost: 2.5 }),
  ]);
  assertEquals(r.length, 1);
  assertEquals(r[0].clicks, 7);
  assertEquals(r[0].spend_cents, 350);
});

Deno.test("ads_daily: verschiedene ASINs derselben Kampagne bleiben getrennt", () => {
  const r = baueAdsDailyRows(T, [
    zeile({ date: "2026-07-01", campaignId: "C1", asin: "B001", clicks: 1 }),
    zeile({ date: "2026-07-01", campaignId: "C1", asin: "B002", clicks: 2 }),
  ]);
  assertEquals(r.length, 2);
});

Deno.test("ads_daily: Schluesselspalten sind Leerstring statt null", () => {
  // null in einer Schluesselspalte wuerde die Eindeutigkeit des Primaerschluessels
  // aushebeln (null <> null in Postgres).
  const r = baueAdsDailyRows(T, [{ date: "2026-07-01", campaignId: "C1", clicks: 1 }]);
  assertEquals(r.length, 1);
  assertEquals(r[0].ad_group_id, "");
  assertEquals(r[0].asin, "");
  assertEquals(r[0].sku, "");
});

Deno.test("ads_daily: Zeilen ohne Datum oder Kampagne werden verworfen", () => {
  const r = baueAdsDailyRows(T, [
    { campaignId: "C1", clicks: 9 }, // kein Datum
    { date: "2026-07-01", clicks: 9 }, // keine Kampagne
    { date: "kaputt", campaignId: "C1", clicks: 9 }, // unlesbares Datum
    zeile({ date: "2026-07-01", campaignId: "C1", clicks: 1 }),
  ]);
  assertEquals(r.length, 1);
  assertEquals(r[0].clicks, 1);
});

Deno.test("ads_daily: leerer Report ergibt keine Zeilen", () => {
  assertEquals(baueAdsDailyRows(T, []).length, 0);
});

// --- baueFenster (Report-Zeitraum) ---

const HEUTE = new Date("2026-08-17T09:00:00Z");

Deno.test("Fenster: relativ endet VOLATIL_TAGE vor heute", () => {
  const f = baueFenster({ days: 30, heute: HEUTE });
  if (!f.ok) throw new Error(f.fehler);
  assertEquals(f.fenster.endDate, "2026-08-14"); // 17.8. minus 3
  assertEquals(f.fenster.startDate, "2026-07-15");
  assertEquals(spanneTage(f.fenster.startDate, f.fenster.endDate), 31);
});

Deno.test("Fenster: include_volatile geht bis gestern", () => {
  const f = baueFenster({ days: 7, includeVolatile: true, heute: HEUTE });
  if (!f.ok) throw new Error(f.fehler);
  assertEquals(f.fenster.endDate, "2026-08-16");
});

Deno.test("Fenster: days=30 ist das Maximum, 31 wird abgelehnt", () => {
  // days ist ein Offset — 30 ergibt 31 Kalendertage, also genau Amazons Grenze.
  assertEquals(baueFenster({ days: 30, heute: HEUTE }).ok, true);
  assertEquals(baueFenster({ days: 31, heute: HEUTE }).ok, false);
  assertEquals(baueFenster({ days: 0, heute: HEUTE }).ok, false);
});

Deno.test("Fenster: explizite Daten werden uebernommen", () => {
  const f = baueFenster({ startDate: "2026-06-14", endDate: "2026-07-14" });
  if (!f.ok) throw new Error(f.fehler);
  assertEquals(f.fenster, { startDate: "2026-06-14", endDate: "2026-07-14" });
  assertEquals(spanneTage("2026-06-14", "2026-07-14"), 31);
});

Deno.test("Fenster: mehr als 31 Kalendertage wird abgelehnt", () => {
  // Genau der Fall, an dem der erste Backfill-Versuch scheiterte (90 Tage).
  const f = baueFenster({ startDate: "2026-05-16", endDate: "2026-08-14" });
  assertEquals(f.ok, false);
  if (!f.ok) assertEquals(f.fehler.includes("31"), true);
});

Deno.test("Fenster: 32 Kalendertage sind schon zu viel", () => {
  assertEquals(baueFenster({ startDate: "2026-07-14", endDate: "2026-08-14" }).ok, false);
});

Deno.test("Fenster: halbes oder verdrehtes Datumspaar wird abgelehnt", () => {
  assertEquals(baueFenster({ startDate: "2026-07-01" }).ok, false);
  assertEquals(baueFenster({ endDate: "2026-07-01" }).ok, false);
  assertEquals(baueFenster({ startDate: "2026-08-01", endDate: "2026-07-01" }).ok, false);
  assertEquals(baueFenster({ startDate: "01.07.2026", endDate: "14.07.2026" }).ok, false);
});

// --- Suchbegriff- und Platzierungs-Report ---

import {
  bauePlacementReportRequest,
  bauePlacementRows,
  baueReportRequest,
  baueSuchbegriffReportRequest,
  baueSuchbegriffRows,
} from "./ads.ts";

Deno.test("Suchbegriff-Report: spSearchTerm nach searchTerm gruppiert, taeglich", () => {
  const r = baueSuchbegriffReportRequest("2026-08-01", "2026-08-14");
  assertEquals(r.configuration.reportTypeId, "spSearchTerm");
  assertEquals(r.configuration.groupBy, ["searchTerm"]);
  assertEquals(r.configuration.timeUnit, "DAILY");
  assertEquals(r.configuration.columns.includes("searchTerm"), true);
  assertEquals(r.configuration.columns.includes("keywordId"), true);
});

Deno.test("Platzierungs-Report: spCampaigns mit campaignPlacement", () => {
  const r = bauePlacementReportRequest("2026-08-01", "2026-08-14");
  assertEquals(r.configuration.reportTypeId, "spCampaigns");
  assertEquals(r.configuration.groupBy, ["campaign", "campaignPlacement"]);
  assertEquals(r.configuration.columns.includes("placementClassification"), true);
});

Deno.test("baueReportRequest: bekannte Typen liefern Anfrage, unbekannter null", () => {
  assertEquals(baueReportRequest("sp-advertised-product", "2026-08-01", "2026-08-02")?.configuration.reportTypeId, "spAdvertisedProduct");
  assertEquals(baueReportRequest("sp-search-term", "2026-08-01", "2026-08-02")?.configuration.reportTypeId, "spSearchTerm");
  assertEquals(baueReportRequest("sp-placement", "2026-08-01", "2026-08-02")?.configuration.reportTypeId, "spCampaigns");
  assertEquals(baueReportRequest("gibt-es-nicht", "2026-08-01", "2026-08-02"), null);
});

Deno.test("Suchbegriff-Zeilen: Schluessel bis zum Suchbegriff, Geld in Cent, keyword vor targeting", () => {
  const rows = baueSuchbegriffRows("t", [
    { date: "2026-08-01", campaignId: 1, campaignName: "K", adGroupId: 2, adGroupName: "G", keywordId: 3, keyword: "beutel", matchType: "BROAD", searchTerm: "staubsauger beutel", impressions: 100, clicks: 5, cost: 1.23, purchases7d: 1, unitsSoldClicks7d: 1, sales7d: 19.99 },
    // Zweite Zeile mit demselben Schluessel wird addiert, nicht ersetzt.
    { date: "2026-08-01", campaignId: 1, adGroupId: 2, keywordId: 3, keyword: "beutel", matchType: "BROAD", searchTerm: "staubsauger beutel", impressions: 50, clicks: 1, cost: 0.1, purchases7d: 0, unitsSoldClicks7d: 0, sales7d: 0 },
    // Auto-Kampagne: kein keyword, dafuer targeting.
    { date: "2026-08-01", campaignId: 9, adGroupId: 8, keywordId: 7, targeting: "close-match", searchTerm: "beutel", impressions: 10, clicks: 0, cost: 0, purchases7d: 0, unitsSoldClicks7d: 0, sales7d: 0 },
  ]);
  assertEquals(rows.length, 2);
  const a = rows.find((r) => r.campaign_id === "1")!;
  assertEquals(a.suchbegriff, "staubsauger beutel");
  assertEquals(a.ziel_id, "3");
  assertEquals(a.ziel_text, "beutel");
  assertEquals(a.impressions, 150);
  assertEquals(a.clicks, 6);
  assertEquals(a.spend_cents, 133);
  assertEquals(a.sales_cents, 1999);
  const b = rows.find((r) => r.campaign_id === "9")!;
  assertEquals(b.ziel_text, "close-match");
});

Deno.test("Suchbegriff-Zeilen: ohne Datum, Kampagne oder Suchbegriff verworfen", () => {
  const rows = baueSuchbegriffRows("t", [
    { campaignId: 1, searchTerm: "x", cost: 1 },
    { date: "2026-08-01", searchTerm: "x", cost: 1 },
    { date: "2026-08-01", campaignId: 1, cost: 1 },
  ]);
  assertEquals(rows, []);
});

Deno.test("Platzierungs-Zeilen: Schluessel Tag+Kampagne+Platzierung", () => {
  const rows = bauePlacementRows("t", [
    { date: "2026-08-01", campaignId: 1, campaignName: "K", placementClassification: "Top of Search on-Amazon", impressions: 100, clicks: 10, cost: 5, purchases7d: 2, unitsSoldClicks7d: 2, sales7d: 40 },
    { date: "2026-08-01", campaignId: 1, campaignName: "K", placementClassification: "Detail Page on-Amazon", impressions: 200, clicks: 4, cost: 1, purchases7d: 0, unitsSoldClicks7d: 0, sales7d: 0 },
    { date: "2026-08-02", campaignId: 1, campaignName: "K", placementClassification: "Top of Search on-Amazon", impressions: 1, clicks: 1, cost: 0.5, purchases7d: 0, unitsSoldClicks7d: 0, sales7d: 0 },
  ]);
  assertEquals(rows.length, 3);
  const top = rows.find((r) => r.datum === "2026-08-01" && r.platzierung === "Top of Search on-Amazon")!;
  assertEquals(top.spend_cents, 500);
  assertEquals(top.sales_cents, 4000);
  assertEquals(top.orders, 2);
});

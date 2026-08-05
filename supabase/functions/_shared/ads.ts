// ads.ts — Amazon Advertising API v3: Report-Anfrage bauen + Kennzahlen rechnen.
//
// Reines Modul: keine DB, kein Netz. Der Netz-/Auth-Teil liegt in der Function
// sync-ads-report; hier nur das, was unit-testbar ist.
//
// Spec verifiziert (2026-07): Advertising API v3 async reporting.
//   POST {endpoint}/reporting/reports
//   Content-Type: application/vnd.createasyncreportrequest.v3+json
//   Body: { name, startDate, endDate, configuration: {
//             adProduct, groupBy, columns, reportTypeId, timeUnit, format } }
//   Für Sponsored Products: adProduct=SPONSORED_PRODUCTS, reportTypeId=spAdvertisedProduct.
//
// GELD: cost und sales sind in v3 nackte Zahlen (kein {amount,currency}) in der
// Profil-Währung. In ganzen Cent summieren, damit nichts driftet.
//
// ACOS ist die zentrale Ads-Kennzahl: Advertising Cost of Sales = Spend / Sales.
// Wie in metrics.ts: aus ROHWERTEN gerechnet, Nenner 0 → null (nicht 0/NaN).

import { round2, safeDiv } from "./metrics.ts";

// 72h-Regel: Ads-Zahlen der letzten ~3 Tage werden von Amazon noch angepasst
// (Klickbetrugs-Filter, verspätete Attribution). Ein Report, dessen Zeitraum in
// dieses Fenster reicht, ist vorläufig.
export const VOLATIL_TAGE = 3;

// Standard-Spalten für den spAdvertisedProduct-Report (7-Tage-Attribution).
export const SP_ADVERTISED_PRODUCT_COLUMNS = [
  "date",
  "campaignId",
  "campaignName",
  "adGroupId",
  "advertisedAsin",
  "advertisedSku",
  "impressions",
  "clicks",
  "cost",
  "purchases7d",
  "unitsSoldClicks7d",
  "sales7d",
];

export interface AdsReportRequest {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  configuration: {
    adProduct: string;
    groupBy: string[];
    columns: string[];
    reportTypeId: string;
    timeUnit: string;
    format: string;
  };
}

/** YYYY-MM-DD aus einem Date (UTC). Die Ads-API will reine Datumsstrings. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Baut die Report-Anfrage für Sponsored Products (Advertised Product).
 * timeUnit DAILY, damit pro Tag+ASIN eine Zeile kommt (feinste Granularität,
 * lässt sich später beliebig aggregieren).
 */
export function baueSpReportRequest(startDate: string, endDate: string): AdsReportRequest {
  return {
    name: `sp-advertised-product ${startDate}..${endDate}`,
    startDate,
    endDate,
    configuration: {
      adProduct: "SPONSORED_PRODUCTS",
      groupBy: ["advertiser"],
      columns: SP_ADVERTISED_PRODUCT_COLUMNS,
      reportTypeId: "spAdvertisedProduct",
      timeUnit: "DAILY",
      format: "GZIP_JSON",
    },
  };
}

/**
 * Ist ein Report mit diesem Enddatum vorläufig? Wahr, wenn endDate innerhalb der
 * letzten VOLATIL_TAGE liegt (Zahlen können sich noch ändern).
 */
export function istVorlaeufig(endDate: string, heute: Date = new Date()): boolean {
  const grenze = new Date(heute);
  grenze.setUTCDate(grenze.getUTCDate() - VOLATIL_TAGE);
  // endDate (YYYY-MM-DD) als UTC-Mitternacht vergleichen.
  const end = new Date(endDate + "T00:00:00Z");
  return end > grenze;
}

// --- Aufbereitung der Report-Zeilen ---

export interface AdsKennzahlen {
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  einheiten: number;
  ctr: number | null; // clicks / impressions
  cvr: number | null; // orders / clicks
  cpc: number | null; // spend / clicks
  acos: number | null; // spend / sales  (Advertising Cost of Sales)
  roas: number | null; // sales / spend
}

export interface AdsOverview {
  data_timestamp: string;
  is_provisional: boolean;
  waehrungshinweis: string;
  gesamt: AdsKennzahlen;
  proKampagne: Array<{ campaignId: string; campaignName: string } & AdsKennzahlen>;
  proAsin: Array<{ asin: string } & AdsKennzahlen>;
  zeitraum: { von: string | null; bis: string | null };
  formeln: Record<string, string>;
  warnungen: string[];
}

const FORMELN: Record<string, string> = {
  acos: "spend / sales × 100 — die zentrale Effizienzkennzahl (niedriger = besser)",
  roas: "sales / spend — Kehrwert-Perspektive zu ACOS",
  ctr: "clicks / impressions × 100",
  cvr: "orders / clicks × 100",
  cpc: "spend / clicks",
  geld: "cost/sales in Cent summiert; Währung = Profil-Währung (nicht im Report enthalten)",
};

class AdsAkku {
  impressions = 0;
  clicks = 0;
  spendCents = 0;
  salesCents = 0;
  orders = 0;
  einheiten = 0;

  add(r: Record<string, any>): void {
    this.impressions += num(r.impressions);
    this.clicks += num(r.clicks);
    this.spendCents += Math.round(num(r.cost) * 100);
    this.salesCents += Math.round(num(r.sales7d) * 100);
    this.orders += num(r.purchases7d);
    this.einheiten += num(r.unitsSoldClicks7d);
  }

  finish(): AdsKennzahlen {
    const spend = round2(this.spendCents / 100);
    const sales = round2(this.salesCents / 100);
    const mul100 = (x: number | null) => (x === null ? null : round2(x * 100));
    return {
      impressions: this.impressions,
      clicks: this.clicks,
      spend,
      sales,
      orders: this.orders,
      einheiten: this.einheiten,
      ctr: mul100(safeDiv(this.clicks, this.impressions)),
      cvr: mul100(safeDiv(this.orders, this.clicks)),
      cpc: nullOrRound(safeDiv(spend, this.clicks)),
      acos: mul100(safeDiv(spend, sales)),
      roas: nullOrRound(safeDiv(sales, spend)),
    };
  }
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
function nullOrRound(x: number | null): number | null {
  return x === null ? null : round2(x);
}

/**
 * Report-Zeilen → Overview. `rows` ist das geparste GZIP_JSON (Array von Zeilen).
 */
export function baueAdsOverview(
  rows: Record<string, any>[],
  data_timestamp: string,
  is_provisional: boolean
): AdsOverview {
  const gesamt = new AdsAkku();
  const kampagnen = new Map<string, { name: string; akku: AdsAkku }>();
  const asins = new Map<string, AdsAkku>();
  const daten: string[] = [];

  for (const r of rows) {
    gesamt.add(r);

    const cid = String(r.campaignId ?? "").trim() || "(ohne Kampagne)";
    let k = kampagnen.get(cid);
    if (!k) {
      k = { name: String(r.campaignName ?? "").trim(), akku: new AdsAkku() };
      kampagnen.set(cid, k);
    }
    k.akku.add(r);

    const asin = String(r.advertisedAsin ?? "").trim();
    if (asin) {
      const a = asins.get(asin) ?? new AdsAkku();
      a.add(r);
      asins.set(asin, a);
    }

    const d = String(r.date ?? "").trim();
    if (d) daten.push(d);
  }

  daten.sort();
  const warnungen: string[] = [];
  if (is_provisional) {
    warnungen.push(
      `Zeitraum reicht in die letzten ${VOLATIL_TAGE} Tage — Ads-Zahlen (Spend/Sales) ` +
        "werden von Amazon noch angepasst. Als vorläufig behandeln."
    );
  }
  if (rows.length === 0) warnungen.push("Keine Ads-Daten im Zeitraum.");

  return {
    data_timestamp,
    is_provisional,
    waehrungshinweis: "Beträge in der Währung des Werbeprofils (nicht im Report enthalten).",
    gesamt: gesamt.finish(),
    proKampagne: [...kampagnen]
      .map(([campaignId, v]) => ({ campaignId, campaignName: v.name, ...v.akku.finish() }))
      .sort((a, b) => b.spend - a.spend),
    proAsin: [...asins]
      .map(([asin, a]) => ({ asin, ...a.finish() }))
      .sort((a, b) => b.spend - a.spend),
    zeitraum: { von: daten[0] ?? null, bis: daten[daten.length - 1] ?? null },
    formeln: FORMELN,
    warnungen,
  };
}

// --- Tagesverlauf (ads_daily) ---
//
// Trennung wie in history.ts: der Row-Builder ist rein (Zeilen -> Zeilen) und
// damit testbar, nur schreibeAdsVerlauf fasst die DB an.

export interface AdsVerlaufErgebnis {
  zeilen: number;
  fehler?: string;
}

/**
 * Report-Zeilen → ads_daily-Zeilen.
 *
 * Aggregiert je (Datum, Kampagne, Anzeigengruppe, ASIN, SKU), weil derselbe
 * Schlüssel im Report mehrfach auftreten kann. Wichtig: Der Upsert ERSETZT die
 * Zeile später, addiert nicht. Was hier herauskommt, muss deshalb die volle
 * Tagessumme für diesen Schlüssel sein — kein Delta.
 *
 * Zeilen ohne Datum oder Kampagne werden verworfen: ohne beides gibt es keinen
 * tragfähigen Schlüssel, und geraten wird hier nichts.
 */
export function baueAdsDailyRows(
  tenant_id: string,
  rows: Record<string, any>[]
): Record<string, unknown>[] {
  interface Eintrag {
    datum: string;
    campaign_id: string;
    ad_group_id: string;
    asin: string;
    sku: string;
    campaign_name: string | null;
    akku: AdsAkku;
  }
  const proSchluessel = new Map<string, Eintrag>();

  for (const r of rows) {
    const datum = String(r.date ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) continue;

    const campaign_id = String(r.campaignId ?? "").trim();
    if (!campaign_id) continue;

    // Leerstring statt null — die Spalten sind Teil des Primärschlüssels.
    const ad_group_id = String(r.adGroupId ?? "").trim();
    const asin = String(r.advertisedAsin ?? "").trim();
    const sku = String(r.advertisedSku ?? "").trim();
    const name = String(r.campaignName ?? "").trim();

    // Nullbyte als Trenner: SKUs duerfen Leerzeichen und Bindestriche enthalten,
    // ein harmloseres Trennzeichen koennte zwei Schluessel verschmelzen lassen.
    const schluessel = [datum, campaign_id, ad_group_id, asin, sku].join("\u0000");

    let e = proSchluessel.get(schluessel);
    if (!e) {
      e = { datum, campaign_id, ad_group_id, asin, sku, campaign_name: name || null, akku: new AdsAkku() };
      proSchluessel.set(schluessel, e);
    }
    // Erste nicht-leere Benennung gewinnt; Amazon lässt das Feld gelegentlich leer.
    if (!e.campaign_name && name) e.campaign_name = name;
    e.akku.add(r);
  }

  const jetzt = new Date().toISOString();
  return [...proSchluessel.values()].map((e) => ({
    tenant_id,
    datum: e.datum,
    campaign_id: e.campaign_id,
    ad_group_id: e.ad_group_id,
    asin: e.asin,
    sku: e.sku,
    campaign_name: e.campaign_name,
    impressions: e.akku.impressions,
    clicks: e.akku.clicks,
    spend_cents: e.akku.spendCents,
    sales_cents: e.akku.salesCents,
    orders: e.akku.orders,
    einheiten: e.akku.einheiten,
    updated_at: jetzt,
  }));
}

/**
 * Schreibt die Tagesreihe per UPSERT. Einziger Teil dieses Moduls, der die DB
 * anfasst. Batchweise, weil ein 30-Tage-Fenster bei vielen ASINs schnell
 * mehrere tausend Zeilen ergibt.
 */
export async function schreibeAdsVerlauf(
  supabase: any,
  tenant_id: string,
  rows: Record<string, any>[]
): Promise<AdsVerlaufErgebnis> {
  const zeilen = baueAdsDailyRows(tenant_id, rows);
  if (zeilen.length === 0) return { zeilen: 0 };

  const BATCH = 500;
  for (let i = 0; i < zeilen.length; i += BATCH) {
    const { error } = await supabase
      .from("ads_daily")
      .upsert(zeilen.slice(i, i + BATCH), {
        onConflict: "tenant_id,datum,campaign_id,ad_group_id,asin,sku",
      });
    if (error) return { zeilen: 0, fehler: `ads_daily: ${error.message}` };
  }
  return { zeilen: zeilen.length };
}

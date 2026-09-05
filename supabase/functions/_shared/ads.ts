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

// --- Report-Fenster ---

/**
 * Groesste Spanne, die Amazon je Anfrage erlaubt — in KALENDERTAGEN inklusive
 * Start und Ende. Verifiziert am 2026-08-17 an der Fehlermeldung:
 *   "startDate to endDate range (90 days) must not exceed maximum range (31 days)"
 *
 * NICHT verwechseln mit der Vorhaltung von ~95 Tagen: die sagt, wie weit man
 * zurueckreichen darf, diese hier, wie breit ein einzelnes Fenster sein darf.
 * Laengere Zeitraeume brauchen mehrere Anfragen mit versetzten Fenstern.
 */
export const MAX_SPANNE_TAGE = 31;

const TAG_MS = 86_400_000;

function istDatum(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

/** Kalendertage von start bis ende, inklusive beider Enden. */
export function spanneTage(startDate: string, endDate: string): number {
  const a = Date.parse(startDate + "T00:00:00Z");
  const b = Date.parse(endDate + "T00:00:00Z");
  return Math.round((b - a) / TAG_MS) + 1;
}

export interface AdsFenster {
  startDate: string;
  endDate: string;
}

/**
 * Bestimmt das Report-Fenster — entweder explizit (Backfill aelterer Zeitraeume)
 * oder relativ zu heute (Tagesbetrieb).
 *
 * Relativ: Ads-Daten fuer heute sind unvollstaendig, das Fenster endet deshalb
 * VOLATIL_TAGE vor heute. include_volatile geht bis gestern und macht den
 * Datensatz spaeter vorlaeufig.
 */
export function baueFenster(opts: {
  days?: number;
  startDate?: unknown;
  endDate?: unknown;
  includeVolatile?: boolean;
  heute?: Date;
}): { ok: true; fenster: AdsFenster } | { ok: false; fehler: string } {
  const { startDate, endDate } = opts;

  // Explizites Fenster: beide Enden oder keines — ein halbes waere zweideutig.
  if (startDate !== undefined || endDate !== undefined) {
    if (!istDatum(startDate) || !istDatum(endDate)) {
      return { ok: false, fehler: "start_date und end_date muessen beide als YYYY-MM-DD angegeben werden" };
    }
    if (startDate > endDate) {
      return { ok: false, fehler: `start_date (${startDate}) liegt nach end_date (${endDate})` };
    }
    const spanne = spanneTage(startDate, endDate);
    if (spanne > MAX_SPANNE_TAGE) {
      return {
        ok: false,
        fehler: `Zeitraum umfasst ${spanne} Tage — Amazon erlaubt hoechstens ${MAX_SPANNE_TAGE} je Anfrage. ` +
          "Laengere Zeitraeume in mehreren Anfragen holen.",
      };
    }
    return { ok: true, fenster: { startDate, endDate } };
  }

  // Relatives Fenster. days ist ein OFFSET: days=30 ergibt 31 Kalendertage.
  const days = opts.days ?? 14;
  if (!Number.isFinite(days) || days < 1 || days > MAX_SPANNE_TAGE - 1) {
    return { ok: false, fehler: `days muss zwischen 1 und ${MAX_SPANNE_TAGE - 1} liegen (ergibt bis zu ${MAX_SPANNE_TAGE} Kalendertage)` };
  }

  const heute = opts.heute ?? new Date();
  const end = new Date(heute);
  end.setUTCDate(end.getUTCDate() - (opts.includeVolatile ? 1 : VOLATIL_TAGE));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { ok: true, fenster: { startDate: ymd(start), endDate: ymd(end) } };
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

export const FORMELN: Record<string, string> = {
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
    // metriken() kennt die 7d-Namen von SP und die 14d-Namen von SB/SD.
    const m = metriken(r);
    this.impressions += m.impressions;
    this.clicks += m.clicks;
    this.spendCents += Math.round(m.cost * 100);
    this.salesCents += Math.round(m.sales * 100);
    this.orders += m.orders;
    this.einheiten += m.einheiten;
  }

  finish(): AdsKennzahlen {
    return kennzahlenAusSummen(this);
  }
}

/**
 * Kennzahlen aus Rohsummen. Die EINZIGE Stelle, an der ACOS, ROAS, CTR, CVR und
 * CPC entstehen — genutzt vom Report-Overview (report_data) wie vom Zeitraum-
 * Verlauf (ads_daily). Zwei Wege zu denselben Zahlen duerfen nicht zwei Formeln
 * haben.
 *
 * Geld kommt in Cent herein und geht in Euro heraus; Nenner 0 ergibt null,
 * nicht 0 — „unbekannt ist nicht null".
 */
export function kennzahlenAusSummen(s: {
  impressions: number;
  clicks: number;
  spendCents: number;
  salesCents: number;
  orders: number;
  einheiten: number;
}): AdsKennzahlen {
  const spend = round2(s.spendCents / 100);
  const sales = round2(s.salesCents / 100);
  const mul100 = (x: number | null) => (x === null ? null : round2(x * 100));
  return {
    impressions: s.impressions,
    clicks: s.clicks,
    spend,
    sales,
    orders: s.orders,
    einheiten: s.einheiten,
    ctr: mul100(safeDiv(s.clicks, s.impressions)),
    cvr: mul100(safeDiv(s.orders, s.clicks)),
    cpc: nullOrRound(safeDiv(spend, s.clicks)),
    acos: mul100(safeDiv(spend, sales)),
    roas: nullOrRound(safeDiv(sales, spend)),
  };
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

// --- Berichte je Anzeigentyp: Suchbegriffe, Platzierungen, Ziele ---
//
// Die Berichte, die man bisher als Bulk-Datei aus der Konsole zog — für
// Sponsored Products, Brands und Display. Alle laufen über denselben
// v3-Reporting-Weg wie spAdvertisedProduct, nur mit anderem adProduct,
// reportTypeId und groupBy.
//
// ATTRIBUTION: SP-Berichte rechnen 7 Tage (purchases7d/sales7d), SB und SD
// liefern in v3 nur 14 Tage (purchases/sales). Das ist Amazons Vorgabe, kein
// Wahlrecht — die Leser weisen es aus, damit niemand SP- und SB-ACOS als
// gleichartig liest.
//
// Die Spaltensätze sind gegen die Ads-API verifiziert (2026-09-06): Amazon
// lehnt unbekannte Spalten mit 400 ab und nennt in der Meldung die gültigen.
//
// KEIN Platzierungsbericht für Sponsored Brands: sbCampaigns erlaubt in v3 nur
// groupBy campaign, keine Platzierung (Amazon: „invalid groupBy values:
// (campaignPlacement). Allowed values: (campaign)"). Es gibt dort nur die
// Spalte topOfSearchImpressionShare. Placement bleibt SP-only.
//
// Sponsored Display liefert im Targeting-Bericht kein Gebot und keinen Zustand
// — die Spalten bleiben dort leer, nicht 0.

export type AdProduct = "SP" | "SB" | "SD";

export type AdsReportTyp =
  | "sp-advertised-product"
  | "sp-search-term"
  | "sp-placement"
  | "sp-targeting"
  | "sb-search-term"
  | "sb-targeting"
  | "sd-targeting";

/** Attributionsfenster in Tagen je Anzeigentyp — siehe Kopfkommentar. */
export const ATTRIBUTION_TAGE: Record<AdProduct, number> = { SP: 7, SB: 14, SD: 14 };

const AD_PRODUCT_API: Record<AdProduct, string> = {
  SP: "SPONSORED_PRODUCTS",
  SB: "SPONSORED_BRANDS",
  SD: "SPONSORED_DISPLAY",
};

const METRIKEN_SP = ["impressions", "clicks", "cost", "purchases7d", "unitsSoldClicks7d", "sales7d"];
const METRIKEN_SB = ["impressions", "clicks", "cost", "purchases", "unitsSold", "sales"];
const METRIKEN_SD = ["impressions", "clicks", "cost", "purchases", "unitsSold", "sales"];

interface ReportDef {
  adProduct: AdProduct;
  reportTypeId: string;
  groupBy: string[];
  columns: string[];
  /** Zieltabelle und Konfliktspalten fuer den Upsert. */
  tabelle: string;
  onConflict: string;
  rows: (tenant_id: string, rows: Record<string, any>[]) => Record<string, unknown>[];
}

/**
 * Rohmetriken einer Report-Zeile, egal welcher Anzeigentyp. SP zuerst (7d),
 * dann die 14d-Namen von SB/SD. Fehlt alles, ist es 0 — eine Zeile ohne
 * Metriken hat der Report nicht geliefert.
 */
export function metriken(r: Record<string, any>): {
  impressions: number; clicks: number; cost: number; sales: number; orders: number; einheiten: number;
} {
  const erste = (...namen: string[]) => {
    for (const n of namen) if (typeof r[n] === "number" && Number.isFinite(r[n])) return r[n];
    return 0;
  };
  return {
    impressions: erste("impressions"),
    clicks: erste("clicks"),
    cost: erste("cost"),
    sales: erste("sales7d", "sales14d", "sales", "salesClicks"),
    orders: erste("purchases7d", "purchases14d", "purchases", "purchasesClicks"),
    einheiten: erste("unitsSoldClicks7d", "unitsSoldClicks14d", "unitsSold", "unitsSoldClicks"),
  };
}

function s(x: unknown): string {
  return x === null || x === undefined ? "" : String(x).trim();
}
function erstesFeld(r: Record<string, any>, ...namen: string[]): string {
  for (const n of namen) { const v = s(r[n]); if (v) return v; }
  return "";
}
function istTag(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}
function centsOderNull(x: unknown): number | null {
  const n = Number(x);
  return x === null || x === undefined || x === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
}

/**
 * Suchbegriff-Zeilen → ads_suchbegriffe_daily. Schlüssel: Anzeigentyp, Tag,
 * Kampagne, Anzeigengruppe, Ziel (Keyword- oder Target-ID) und der Suchbegriff.
 * Bei Auto- und Product-Targeting liefert Amazon die Zielangabe in `targeting`
 * statt `keyword`; SB nennt das Feld `keywordText`. Alles landet in ziel_text.
 */
export function baueSuchbegriffRows(tenant_id: string, rows: Record<string, any>[], adProduct: AdProduct = "SP"): Record<string, unknown>[] {
  interface Eintrag {
    datum: string; campaign_id: string; ad_group_id: string; ziel_id: string; suchbegriff: string;
    campaign_name: string | null; ad_group_name: string | null; ziel_text: string | null; match_type: string | null;
    akku: AdsAkku;
  }
  const proSchluessel = new Map<string, Eintrag>();

  for (const r of rows) {
    const datum = s(r.date).slice(0, 10);
    if (!istTag(datum)) continue;
    const campaign_id = s(r.campaignId);
    const suchbegriff = s(r.searchTerm);
    if (!campaign_id || !suchbegriff) continue;

    const ad_group_id = s(r.adGroupId);
    const ziel_id = erstesFeld(r, "keywordId", "targetId", "targetingId");
    const schluessel = JSON.stringify([datum, campaign_id, ad_group_id, ziel_id, suchbegriff]);

    let e = proSchluessel.get(schluessel);
    if (!e) {
      e = {
        datum, campaign_id, ad_group_id, ziel_id, suchbegriff,
        campaign_name: s(r.campaignName) || null,
        ad_group_name: s(r.adGroupName) || null,
        ziel_text: erstesFeld(r, "keyword", "keywordText", "targeting", "targetingText", "targetingExpression") || null,
        match_type: erstesFeld(r, "matchType", "targetingType") || null,
        akku: new AdsAkku(),
      };
      proSchluessel.set(schluessel, e);
    }
    e.akku.add(r);
  }

  const jetzt = new Date().toISOString();
  return [...proSchluessel.values()].map((e) => ({
    tenant_id,
    ad_product: adProduct,
    datum: e.datum,
    campaign_id: e.campaign_id,
    ad_group_id: e.ad_group_id,
    ziel_id: e.ziel_id,
    suchbegriff: e.suchbegriff,
    campaign_name: e.campaign_name,
    ad_group_name: e.ad_group_name,
    ziel_text: e.ziel_text,
    match_type: e.match_type,
    impressions: e.akku.impressions,
    clicks: e.akku.clicks,
    spend_cents: e.akku.spendCents,
    sales_cents: e.akku.salesCents,
    orders: e.akku.orders,
    einheiten: e.akku.einheiten,
    updated_at: jetzt,
  }));
}

/** Platzierungs-Zeilen → ads_placement_daily. Schlüssel: Anzeigentyp, Tag, Kampagne, Platzierung. */
export function bauePlacementRows(tenant_id: string, rows: Record<string, any>[], adProduct: AdProduct = "SP"): Record<string, unknown>[] {
  interface Eintrag {
    datum: string; campaign_id: string; platzierung: string; campaign_name: string | null; akku: AdsAkku;
  }
  const proSchluessel = new Map<string, Eintrag>();

  for (const r of rows) {
    const datum = s(r.date).slice(0, 10);
    if (!istTag(datum)) continue;
    const campaign_id = s(r.campaignId);
    const platzierung = s(r.placementClassification);
    if (!campaign_id || !platzierung) continue;

    const schluessel = JSON.stringify([datum, campaign_id, platzierung]);
    let e = proSchluessel.get(schluessel);
    if (!e) {
      e = { datum, campaign_id, platzierung, campaign_name: s(r.campaignName) || null, akku: new AdsAkku() };
      proSchluessel.set(schluessel, e);
    }
    e.akku.add(r);
  }

  const jetzt = new Date().toISOString();
  return [...proSchluessel.values()].map((e) => ({
    tenant_id,
    ad_product: adProduct,
    datum: e.datum,
    campaign_id: e.campaign_id,
    platzierung: e.platzierung,
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
 * Ziel-Zeilen (Keyword / Product-Target) → ads_ziele_daily. Das ist die Ebene,
 * die in der Bulk-Datei als „Keyword" und „Produkt-Targeting" steht: Leistung
 * je Ziel und Tag, dazu das an dem Tag gültige Gebot und der Zustand. Damit
 * lässt sich nachvollziehen, welches Gebot welche Leistung brachte.
 *
 * Gebot und Zustand sind Momentaufnahmen aus dem Report, kein Summenwert —
 * bei mehreren Zeilen je Schlüssel gewinnt die zuletzt gesehene.
 */
export function baueZieleRows(tenant_id: string, rows: Record<string, any>[], adProduct: AdProduct = "SP"): Record<string, unknown>[] {
  interface Eintrag {
    datum: string; campaign_id: string; ad_group_id: string; ziel_id: string;
    campaign_name: string | null; ad_group_name: string | null; text: string | null; match_type: string | null;
    gebot_cents: number | null; state: string | null; akku: AdsAkku;
  }
  const proSchluessel = new Map<string, Eintrag>();

  for (const r of rows) {
    const datum = s(r.date).slice(0, 10);
    if (!istTag(datum)) continue;
    const campaign_id = s(r.campaignId);
    const ziel_id = erstesFeld(r, "keywordId", "targetId", "targetingId");
    if (!campaign_id || !ziel_id) continue;

    const ad_group_id = s(r.adGroupId);
    const schluessel = JSON.stringify([datum, campaign_id, ad_group_id, ziel_id]);
    let e = proSchluessel.get(schluessel);
    if (!e) {
      e = {
        datum, campaign_id, ad_group_id, ziel_id,
        campaign_name: s(r.campaignName) || null,
        ad_group_name: s(r.adGroupName) || null,
        text: erstesFeld(r, "keyword", "keywordText", "targeting", "targetingText", "targetingExpression") || null,
        match_type: erstesFeld(r, "matchType", "targetingType", "keywordType") || null,
        gebot_cents: null, state: null, akku: new AdsAkku(),
      };
      proSchluessel.set(schluessel, e);
    }
    const gebot = centsOderNull(r.keywordBid ?? r.targetingBid ?? r.bid);
    if (gebot !== null) e.gebot_cents = gebot;
    const state = erstesFeld(r, "adKeywordStatus", "targetingStatus", "keywordStatus", "status");
    if (state) e.state = state;
    e.akku.add(r);
  }

  const jetzt = new Date().toISOString();
  return [...proSchluessel.values()].map((e) => ({
    tenant_id,
    ad_product: adProduct,
    datum: e.datum,
    campaign_id: e.campaign_id,
    ad_group_id: e.ad_group_id,
    ziel_id: e.ziel_id,
    campaign_name: e.campaign_name,
    ad_group_name: e.ad_group_name,
    text: e.text,
    match_type: e.match_type,
    gebot_cents: e.gebot_cents,
    state: e.state,
    impressions: e.akku.impressions,
    clicks: e.akku.clicks,
    spend_cents: e.akku.spendCents,
    sales_cents: e.akku.salesCents,
    orders: e.akku.orders,
    einheiten: e.akku.einheiten,
    updated_at: jetzt,
  }));
}

const SUCHBEGRIFFE = { tabelle: "ads_suchbegriffe_daily", onConflict: "tenant_id,ad_product,datum,campaign_id,ad_group_id,ziel_id,suchbegriff" };
const PLACEMENT = { tabelle: "ads_placement_daily", onConflict: "tenant_id,ad_product,datum,campaign_id,platzierung" };
const ZIELE = { tabelle: "ads_ziele_daily", onConflict: "tenant_id,ad_product,datum,campaign_id,ad_group_id,ziel_id" };

/**
 * Bauplan je Report-Typ. sp-advertised-product steht NICHT hier: es hat einen
 * eigenen Weg (report_data-Blob + ads_daily), siehe sync-ads-report.
 */
export const ADS_REPORTS: Record<Exclude<AdsReportTyp, "sp-advertised-product">, ReportDef> = {
  "sp-search-term": {
    adProduct: "SP", reportTypeId: "spSearchTerm", groupBy: ["searchTerm"],
    columns: ["date", "campaignId", "campaignName", "adGroupId", "adGroupName", "keywordId", "keyword", "matchType", "targeting", "searchTerm", ...METRIKEN_SP],
    ...SUCHBEGRIFFE, rows: (t, r) => baueSuchbegriffRows(t, r, "SP"),
  },
  "sp-placement": {
    adProduct: "SP", reportTypeId: "spCampaigns", groupBy: ["campaign", "campaignPlacement"],
    columns: ["date", "campaignId", "campaignName", "placementClassification", ...METRIKEN_SP],
    ...PLACEMENT, rows: (t, r) => bauePlacementRows(t, r, "SP"),
  },
  "sp-targeting": {
    adProduct: "SP", reportTypeId: "spTargeting", groupBy: ["targeting"],
    columns: ["date", "campaignId", "campaignName", "adGroupId", "adGroupName", "keywordId", "keyword", "matchType", "targeting", "keywordType", "keywordBid", "adKeywordStatus", ...METRIKEN_SP],
    ...ZIELE, rows: (t, r) => baueZieleRows(t, r, "SP"),
  },
  "sb-search-term": {
    adProduct: "SB", reportTypeId: "sbSearchTerm", groupBy: ["searchTerm"],
    columns: ["date", "campaignId", "campaignName", "adGroupId", "adGroupName", "keywordId", "keywordText", "matchType", "searchTerm", ...METRIKEN_SB],
    ...SUCHBEGRIFFE, rows: (t, r) => baueSuchbegriffRows(t, r, "SB"),
  },
  "sb-targeting": {
    adProduct: "SB", reportTypeId: "sbTargeting", groupBy: ["targeting"],
    columns: ["date", "campaignId", "campaignName", "adGroupId", "adGroupName", "keywordId", "keywordText", "matchType", "keywordBid", "adKeywordStatus", ...METRIKEN_SB],
    ...ZIELE, rows: (t, r) => baueZieleRows(t, r, "SB"),
  },
  "sd-targeting": {
    adProduct: "SD", reportTypeId: "sdTargeting", groupBy: ["targeting"],
    columns: ["date", "campaignId", "campaignName", "adGroupId", "adGroupName", "targetingId", "targetingText", "targetingExpression", ...METRIKEN_SD],
    ...ZIELE, rows: (t, r) => baueZieleRows(t, r, "SD"),
  },
};

export const ALLE_REPORT_TYPEN: AdsReportTyp[] = ["sp-advertised-product", ...(Object.keys(ADS_REPORTS) as AdsReportTyp[])];

export function istReportTyp(x: unknown): x is AdsReportTyp {
  return typeof x === "string" && (ALLE_REPORT_TYPEN as string[]).includes(x);
}

/** Report-Anfrage je Typ. Unbekannter Typ → null, damit der Aufrufer sauber
 *  mit 400 antworten kann statt einen falschen Report anzufordern. */
export function baueReportRequest(typ: string, startDate: string, endDate: string): AdsReportRequest | null {
  if (typ === "sp-advertised-product") return baueSpReportRequest(startDate, endDate);
  const def = (ADS_REPORTS as Record<string, ReportDef>)[typ];
  if (!def) return null;
  return {
    name: `${typ} ${startDate}..${endDate}`,
    startDate,
    endDate,
    configuration: {
      adProduct: AD_PRODUCT_API[def.adProduct],
      groupBy: def.groupBy,
      columns: def.columns,
      reportTypeId: def.reportTypeId,
      timeUnit: "DAILY",
      format: "GZIP_JSON",
    },
  };
}

/** Rückwärtskompatible Einzelbauer — Tests und ältere Aufrufer. */
export function baueSuchbegriffReportRequest(startDate: string, endDate: string): AdsReportRequest {
  return baueReportRequest("sp-search-term", startDate, endDate)!;
}
export function bauePlacementReportRequest(startDate: string, endDate: string): AdsReportRequest {
  return baueReportRequest("sp-placement", startDate, endDate)!;
}

/**
 * Schreibt die Zeilen eines Berichts in seine Tagestabelle. Für alle Typen
 * außer sp-advertised-product der einzige Speicherweg.
 */
export async function schreibeBericht(
  supabase: any,
  typ: string,
  tenant_id: string,
  rows: Record<string, any>[],
): Promise<AdsVerlaufErgebnis> {
  const def = (ADS_REPORTS as Record<string, ReportDef>)[typ];
  if (!def) return { zeilen: 0, fehler: `Kein Speicherweg fuer ${typ}` };
  return schreibeTageszeilen(supabase, def.tabelle, def.onConflict, def.rows(tenant_id, rows));
}

/** Batchweiser Upsert in eine der Tagestabellen. */
export async function schreibeTageszeilen(
  supabase: any,
  tabelle: string,
  onConflict: string,
  zeilen: Record<string, unknown>[],
): Promise<AdsVerlaufErgebnis> {
  if (zeilen.length === 0) return { zeilen: 0 };
  const BATCH = 500;
  for (let i = 0; i < zeilen.length; i += BATCH) {
    const { error } = await supabase.from(tabelle).upsert(zeilen.slice(i, i + BATCH), { onConflict });
    if (error) return { zeilen: 0, fehler: `${tabelle}: ${error.message}` };
  }
  return { zeilen: zeilen.length };
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

// product.ts — ASIN-Steckbrief: führt die drei Report-Quellen pro ASIN zusammen.
//
// Reines Modul: keine DB, kein Netz. Bekommt die drei Payloads injiziert.
//
// DER ZENTRALE GRUNDSATZ (am echten Konto belegt, 2026-07-17): Die drei Quellen
// sind NICHT deckungsgleich und dürfen NICHT zu einer Gesamtzahl verschmolzen
// werden:
//   * Sales & Traffic deckt EINEN Marktplatz (DE) über SEINEN Zeitraum ab (z.B. 91 Tage).
//   * Orders deckt MEHRERE Kanäle (Amazon.de, .com.be, Non-Amazon) über einen
//     ANDEREN Zeitraum ab (z.B. 30 Tage).
//   * Listings ist eine Momentaufnahme aller Angebote (Stand jetzt).
// Real: von 3 Orders-ASINs waren 2 NUR in Orders (fremde Kanäle), nur 1 ASIN war
// in allen drei Reports. Sessions aus S&T und Bestellungen aus Orders
// nebeneinanderzustellen, als wäre es derselbe Zeitraum/Kanal, wäre schlicht falsch.
//
// Deshalb: pro ASIN jede Quelle SEPARAT, jeweils mit Herkunft/Zeitraum/Kanal
// beschriftet. Keine quellenübergreifende Summe. Die "hinweise" sind
// deterministische Regeln (kein LLM) und benennen genau die Diskrepanzen.

const SESSIONS_OHNE_VERKAUF_SCHWELLE = 20; // ab so vielen Sessions ohne Verkauf ist es ein Signal

export interface SalesTrafficTeil {
  quelle: "sales_traffic";
  zeitraum: { von: string | null; bis: string | null };
  marktplatz: string | null;
  sessions: number;
  pageViews: number;
  unitsOrdered: number;
  umsatzOrdered: number;
  cvrUnitSession: number | null;
}

export interface OrdersTeil {
  quelle: "orders";
  stand: string; // data_timestamp — der Orders-Payload trägt keinen Zeitraum
  bestellungen: number;
  einheiten: number;
  umsatz_bekannt: number | null; // null wenn ALLE Positionen ohne Preis (MCF)
  positionen_ohne_preis: number;
  kanaele: string[];
}

export interface ListingTeil {
  quelle: "listing";
  stand: string;
  angebote: number;
  aktiv: number;
  status: string[]; // vorkommende Status
  preis_min: number | null;
  preis_max: number | null;
  fulfillment: string[]; // DEFAULT / AMAZON_* pro ASIN
  bestand_merchant: number | null; // Summe über Merchant-Angebote; null wenn nur FBA
}

export interface ProduktSteckbrief {
  asin: string;
  sales_traffic: SalesTrafficTeil | null;
  orders: OrdersTeil | null;
  listing: ListingTeil | null;
  hinweise: string[];
}

export interface ProductPerformance {
  produkte: ProduktSteckbrief[];
  quellen: {
    sales_traffic: { vorhanden: boolean; zeitraum: { von: string | null; bis: string | null }; marktplatz: string | null };
    orders: { vorhanden: boolean; stand: string | null };
    listing: { vorhanden: boolean; stand: string | null };
  };
  warnung: string;
  formeln: Record<string, string>;
}

export interface Quelle {
  payload: Record<string, any>;
  data_timestamp: string;
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
function parsePreis(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function parseMenge(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function centsToEuro(c: number): number {
  return round2(c / 100);
}

// --- pro Quelle einen ASIN-Teil bauen ---

function salesTeil(st: Quelle | null): Map<string, SalesTrafficTeil> {
  const m = new Map<string, SalesTrafficTeil>();
  if (!st) return m;
  const spec = st.payload.reportSpecification ?? {};
  const zeitraum = { von: spec.dataStartTime ?? null, bis: spec.dataEndTime ?? null };
  const marktplatz = spec.marketplaceIds?.[0] ?? null;
  for (const a of st.payload.salesAndTrafficByAsin ?? []) {
    const s = a.salesByAsin ?? {};
    const t = a.trafficByAsin ?? {};
    const sessions = num(t.sessions);
    const units = num(s.unitsOrdered);
    m.set(a.childAsin, {
      quelle: "sales_traffic",
      zeitraum,
      marktplatz,
      sessions,
      pageViews: num(t.pageViews),
      unitsOrdered: units,
      umsatzOrdered: round2(num(s.orderedProductSales?.amount)),
      cvrUnitSession: sessions ? round2((units / sessions) * 100) : null,
    });
  }
  return m;
}

function ordersTeil(o: Quelle | null): Map<string, OrdersTeil> {
  const m = new Map<string, OrdersTeil>();
  if (!o) return m;
  const stand = o.data_timestamp;
  const proAsin = new Map<string, { orderIds: Set<string>; einheiten: number; cents: number; ohnePreis: number; kanaele: Set<string> }>();
  for (const r of o.payload.rows ?? []) {
    const asin = (r["asin"] ?? "").trim();
    if (!asin) continue;
    let e = proAsin.get(asin);
    if (!e) {
      e = { orderIds: new Set(), einheiten: 0, cents: 0, ohnePreis: 0, kanaele: new Set() };
      proAsin.set(asin, e);
    }
    const id = (r["amazon-order-id"] ?? "").trim();
    if (id) e.orderIds.add(id);
    e.einheiten += parseMenge(r["quantity"]) ?? 0;
    const ch = (r["sales-channel"] ?? "").trim();
    if (ch) e.kanaele.add(ch);
    const preis = parsePreis(r["item-price"]);
    if (preis === null) e.ohnePreis++;
    else e.cents += Math.round(preis * 100);
  }
  for (const [asin, e] of proAsin) {
    const bepreist = (o.payload.rows ?? []).filter((r: any) => (r["asin"] ?? "").trim() === asin && parsePreis(r["item-price"]) !== null).length;
    m.set(asin, {
      quelle: "orders",
      stand,
      bestellungen: e.orderIds.size,
      einheiten: e.einheiten,
      // Wenn KEINE Position einen Preis hatte: unbekannt (nicht 0). Siehe orders.ts.
      umsatz_bekannt: bepreist === 0 ? null : centsToEuro(e.cents),
      positionen_ohne_preis: e.ohnePreis,
      kanaele: [...e.kanaele].sort(),
    });
  }
  return m;
}

function listingTeil(l: Quelle | null): Map<string, ListingTeil> {
  const m = new Map<string, ListingTeil>();
  if (!l) return m;
  const stand = l.data_timestamp;
  const proAsin = new Map<string, Record<string, string>[]>();
  for (const r of l.payload.rows ?? []) {
    const asin = (r["asin1"] ?? "").trim();
    if (!asin) continue;
    (proAsin.get(asin) ?? proAsin.set(asin, []).get(asin)!).push(r);
  }
  for (const [asin, angebote] of proAsin) {
    const preise = angebote.map((r) => parsePreis(r["price"])).filter((p): p is number => p !== null);
    const status = [...new Set(angebote.map((r) => (r["status"] ?? "").trim()).filter(Boolean))];
    const fulfillment = [...new Set(angebote.map((r) => (r["fulfillment-channel"] ?? "").trim()).filter(Boolean))];
    // Merchant-Bestand: nur DEFAULT-Angebote mit lesbarer Menge. FBA führt hier nichts.
    const merchant = angebote.filter((r) => (r["fulfillment-channel"] ?? "").trim().toUpperCase() === "DEFAULT");
    const merchantMengen = merchant.map((r) => parseMenge(r["quantity"])).filter((q): q is number => q !== null);
    m.set(asin, {
      quelle: "listing",
      stand,
      angebote: angebote.length,
      aktiv: angebote.filter((r) => (r["status"] ?? "").trim().toLowerCase() === "active").length,
      status,
      preis_min: preise.length ? Math.min(...preise) : null,
      preis_max: preise.length ? Math.max(...preise) : null,
      fulfillment,
      bestand_merchant: merchantMengen.length ? merchantMengen.reduce((a, b) => a + b, 0) : null,
    });
  }
  return m;
}

function baueHinweise(s: SalesTrafficTeil | null, o: OrdersTeil | null, l: ListingTeil | null): string[] {
  const h: string[] = [];

  // Traffic ohne Verkauf (Conversion-Problem) — nur aus S&T, klar auf dessen Zeitraum bezogen.
  if (s && s.sessions >= SESSIONS_OHNE_VERKAUF_SCHWELLE && s.unitsOrdered === 0) {
    h.push(`${s.sessions} Sessions im S&T-Zeitraum ohne einen einzigen Verkauf — Conversion-/Angebotsproblem prüfen.`);
  }

  // Verkauft nur außerhalb des S&T-Marktplatzes.
  if (o && !s) {
    h.push(`Bestellungen vorhanden, aber NICHT im Sales-&-Traffic-Report — verkauft über Kanäle außerhalb des S&T-Marktplatzes (${o.kanaele.join(", ")}).`);
  }

  // Aktiver Merchant-Bestand 0 = Out of Stock.
  if (l && l.bestand_merchant === 0 && l.aktiv > 0 && l.fulfillment.includes("DEFAULT")) {
    h.push("Aktives Merchant-Angebot mit Bestand 0 — kann nichts verkaufen (Out of Stock).");
  }

  // Traffic, aber Angebot nicht aktiv.
  if (s && s.sessions > 0 && l && l.aktiv === 0) {
    h.push("Traffic vorhanden, aber kein aktives Angebot — verlorene Sichtbarkeit.");
  }

  // FBA-Bestand nicht sichtbar.
  if (l && l.fulfillment.some((f) => f.toUpperCase().startsWith("AMAZON"))) {
    h.push("Enthält FBA-Angebote — deren Lagerbestand steht NICHT in diesen Daten (FBA-Report nötig).");
  }

  return h;
}

export function baueProductPerformance(
  sales: Quelle | null,
  orders: Quelle | null,
  listings: Quelle | null,
  opts: { asin?: string; limit?: number } = {}
): ProductPerformance {
  const sMap = salesTeil(sales);
  const oMap = ordersTeil(orders);
  const lMap = listingTeil(listings);

  // Basis-Menge: ASINs mit tatsächlicher Aktivität (Traffic ODER Verkauf).
  // Listings allein (1500+, meist inaktiv) würde die Liste fluten. Ein gezielt
  // angefragter ASIN wird aber immer gezeigt, auch wenn er nur ein Listing hat.
  let asins: string[];
  if (opts.asin) {
    asins = [opts.asin];
  } else {
    asins = [...new Set([...sMap.keys(), ...oMap.keys()])];
  }

  let produkte: ProduktSteckbrief[] = asins.map((asin) => {
    const s = sMap.get(asin) ?? null;
    const o = oMap.get(asin) ?? null;
    const l = lMap.get(asin) ?? null;
    return { asin, sales_traffic: s, orders: o, listing: l, hinweise: baueHinweise(s, o, l) };
  });

  // Sortierung: S&T-Umsatz, dann Sessions, dann Orders-Einheiten.
  produkte.sort((a, b) =>
    (b.sales_traffic?.umsatzOrdered ?? 0) - (a.sales_traffic?.umsatzOrdered ?? 0) ||
    (b.sales_traffic?.sessions ?? 0) - (a.sales_traffic?.sessions ?? 0) ||
    (b.orders?.einheiten ?? 0) - (a.orders?.einheiten ?? 0)
  );

  if (opts.limit && opts.limit > 0) produkte = produkte.slice(0, opts.limit);

  const spec = sales?.payload.reportSpecification ?? {};

  return {
    produkte,
    quellen: {
      sales_traffic: {
        vorhanden: !!sales,
        zeitraum: { von: spec.dataStartTime ?? null, bis: spec.dataEndTime ?? null },
        marktplatz: spec.marketplaceIds?.[0] ?? null,
      },
      orders: { vorhanden: !!orders, stand: orders?.data_timestamp ?? null },
      listing: { vorhanden: !!listings, stand: listings?.data_timestamp ?? null },
    },
    warnung:
      "Die drei Quellen decken VERSCHIEDENE Zeiträume und Kanäle ab (Sales & Traffic: " +
      "ein Marktplatz, sein Zeitraum; Orders: mehrere Kanäle, anderer Zeitraum; " +
      "Listing: Momentaufnahme). Pro ASIN je Quelle getrennt gelistet — NICHT zu " +
      "einer Gesamtzahl addieren.",
    formeln: {
      basis: "ASINs mit Traffic (S&T) ODER Bestellung (Orders); gezielt angefragter ASIN immer",
      umsatz_bekannt_orders: "Σ item-price je ASIN; null wenn KEINE Position einen Preis hat (MCF)",
      bestand_merchant: "Σ quantity nur über DEFAULT-Angebote; FBA-Bestand ist hier NICHT enthalten",
    },
  };
}

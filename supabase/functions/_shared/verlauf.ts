// verlauf.ts — Aggregation ÜBER EINEN ZEITRAUM aus den Verlaufs-Tabellen
// (sales_daily, orders_history, returns_history).
//
// Kerntrick: Die Verlaufs-Zeilen werden zurück in die Payload-Form gebracht, die
// die BEREITS GETESTETEN Aggregatoren (metrics/orders/returns) erwarten. So bleibt
// die ehrliche Rechenlogik (unbekannt != 0, item-price-Ambiguität, Konsistenz) an
// EINER Stelle — hier wird nur geladen, umgeformt und der Zeitraum überschrieben.
//
// Skalierungshinweis: Bei sehr großen Verkäufern über 24 Monate können die
// Orders-Zeilen umfangreich werden (paginiert geladen, im Speicher aggregiert).
// Für den aktuellen Bedarf bewusst so — Reuse der getesteten Logik vor
// vorzeitiger Optimierung. Eine spätere SQL-seitige Aggregation ändert nichts an
// der Schnittstelle.

import { aggregiereNachDatum } from "./metrics.ts";
import { baueOrdersOverview } from "./orders.ts";
import { baueReturnsOverview } from "./returns.ts";

export type VerlaufArt = "sales" | "orders" | "returns" | "orders_umsatz";

/** 'YYYY-MM-DD' von heute mit Offset. */
function tagOffset(tage: number): string {
  const d = new Date();
  d.setDate(d.getDate() - tage);
  return d.toISOString().slice(0, 10);
}

/** Normiert/setzt Default-Zeitraum. Default = letzte 90 Tage. Max 24 Monate. */
function zeitraum(args: { von?: unknown; bis?: unknown }): { von: string; bis: string } {
  const bis = typeof args.bis === "string" && args.bis ? args.bis.slice(0, 10) : tagOffset(0);
  const von = typeof args.von === "string" && args.von ? args.von.slice(0, 10) : tagOffset(90);
  return { von, bis };
}

/** Lädt alle Zeilen einer Tabelle im Zeitraum, paginiert (PostgREST-Limit umgehen). */
async function alleZeilen(
  supabase: any,
  tabelle: string,
  tenant_id: string,
  datumsSpalte: string,
  von: string,
  bisExklusiv: string
): Promise<any[]> {
  const SEITE = 1000;
  let from = 0;
  const raus: any[] = [];
  while (true) {
    const { data, error } = await supabase
      .from(tabelle)
      .select("*")
      .eq("tenant_id", tenant_id)
      .gte(datumsSpalte, von)
      .lt(datumsSpalte, bisExklusiv)
      .order(datumsSpalte, { ascending: true })
      .range(from, from + SEITE - 1);
    if (error) throw new Error(`${tabelle}: ${error.message}`);
    if (!data || data.length === 0) break;
    raus.push(...data);
    if (data.length < SEITE) break;
    from += SEITE;
  }
  return raus;
}

/** bis (inklusiv) -> exklusive Obergrenze (nächster Tag), damit der bis-Tag ganz zählt. */
function bisExklusiv(bis: string): string {
  const d = new Date(bis + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Alle Kalendertage von..bis (inklusiv, UTC), als 'YYYY-MM-DD'. */
function tageIm(von: string, bis: string): string[] {
  const raus: string[] = [];
  const d = new Date(von + "T00:00:00Z");
  const end = new Date(bis + "T00:00:00Z");
  // 400-Tage-Sicherung gegen kaputte Eingaben (von>bis liefert leer).
  for (let i = 0; d.getTime() <= end.getTime() && i < 3700; i++) {
    raus.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return raus;
}

const FEHLEND_CAP = 62; // fehlende_tage-Liste deckeln (Anzahl bleibt vollständig)

export interface ZeitraumAnalyse {
  angefragt: { von: string; bis: string };
  verfuegbar: { von: string; bis: string } | null;
  latest_available_date: string | null;
  tage_mit_daten: number;
  fehlende_tage: string[];
  fehlende_tage_anzahl: number;
  is_provisional: boolean;
  warnungen: string[];
}

/**
 * Vergleicht den ANGEFRAGTEN Zeitraum mit den TATSÄCHLICH vorhandenen Tagesdaten.
 * Rein & testbar. Kernprinzip Ehrlichkeit: nie stillschweigend behaupten, der
 * volle Zeitraum sei enthalten. `is_provisional` = es fehlt mindestens ein Tag.
 */
export function analysiereZeitraum(von: string, bis: string, vorhandeneDaten: string[]): ZeitraumAnalyse {
  const set = new Set(vorhandeneDaten.map((d) => String(d).slice(0, 10)));
  const alle = tageIm(von, bis);
  const imBereich = [...set].filter((t) => t >= von && t <= bis).sort();
  const fehlend = alle.filter((t) => !set.has(t));

  const verfuegbar = imBereich.length ? { von: imBereich[0], bis: imBereich[imBereich.length - 1] } : null;
  const warnungen: string[] = [];
  if (!verfuegbar) {
    warnungen.push("Keine Sales-&-Traffic-Daten im angefragten Zeitraum.");
  } else {
    if (verfuegbar.bis < bis) {
      warnungen.push(`Sales-&-Traffic-Daten reichen nur bis ${verfuegbar.bis}; Amazon liefert die letzten 1–2 Tage verzögert.`);
    }
    if (verfuegbar.von > von) {
      warnungen.push(`Daten beginnen erst am ${verfuegbar.von}; davor liegen keine Sales-&-Traffic-Daten vor.`);
    }
    const innen = fehlend.filter((t) => t > verfuegbar.von && t < verfuegbar.bis);
    if (innen.length) warnungen.push(`${innen.length} Tag(e) innerhalb des verfügbaren Zeitraums fehlen (Datenlücke).`);
  }

  return {
    angefragt: { von, bis },
    verfuegbar,
    latest_available_date: verfuegbar?.bis ?? null,
    tage_mit_daten: imBereich.length,
    fehlende_tage: fehlend.slice(0, FEHLEND_CAP),
    fehlende_tage_anzahl: fehlend.length,
    is_provisional: fehlend.length > 0,
    warnungen,
  };
}

// --- Sales (aus sales_daily) ---

export async function salesRange(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const { von, bis } = zeitraum(args);
  const rows = await alleZeilen(supabase, "sales_daily", tenant_id, "datum", von, bisExklusiv(bis));
  if (rows.length === 0) {
    return { keine_daten: true, art: "sales", zeitraum: { von, bis }, hinweis: "Keine Sales-Historie im Zeitraum." };
  }

  // Zurück in die Payload-Form für aggregiereNachDatum (nutzt die ehrlichen Formeln).
  const payload = {
    salesAndTrafficByDate: rows.map((r) => ({
      date: r.datum,
      salesByDate: {
        unitsOrdered: r.units_ordered,
        totalOrderItems: r.total_order_items,
        unitsShipped: r.units_shipped,
        ordersShipped: r.orders_shipped,
        unitsRefunded: r.units_refunded,
        orderedProductSales: { amount: r.ordered_sales_cents / 100, currencyCode: r.waehrung },
        shippedProductSales: { amount: r.shipped_sales_cents / 100, currencyCode: r.waehrung },
      },
      trafficByDate: { sessions: r.sessions, pageViews: r.page_views },
    })),
  };
  const gesamt = aggregiereNachDatum(payload);

  // Monatsreihe für Charts (kompakt, funktioniert auch über 24 Monate).
  const proMonat = new Map<string, { umsatz_cents: number; units: number; sessions: number }>();
  for (const r of rows) {
    const monat = String(r.datum).slice(0, 7);
    const e = proMonat.get(monat) ?? { umsatz_cents: 0, units: 0, sessions: 0 };
    e.umsatz_cents += r.ordered_sales_cents;
    e.units += r.units_ordered;
    e.sessions += r.sessions;
    proMonat.set(monat, e);
  }
  // Angeschnittenen START-Monat weglassen: beginnt der Zeitraum mitten im Monat,
  // hat dieser Monat nur wenige Tage -> irreführender Stummel-Balken. Der laufende
  // End-Monat (bis heute) bleibt bewusst drin (= „so weit diesen Monat").
  const vonMonat = von.slice(0, 7);
  const startAngeschnitten = von.slice(8, 10) !== "01";
  const monatlich = [...proMonat]
    .filter(([monat]) => !(startAngeschnitten && monat === vonMonat))
    .map(([monat, e]) => ({
      monat,
      umsatz: Math.round(e.umsatz_cents) / 100,
      units: e.units,
      sessions: e.sessions,
      cvr: e.sessions ? Math.round((e.units / e.sessions) * 10000) / 100 : null,
    }));

  // Ehrlichkeit: angefragten Zeitraum mit den TATSÄCHLICH vorhandenen Tagen abgleichen.
  const analyse = analysiereZeitraum(von, bis, rows.map((r) => String(r.datum)));
  const data_timestamp = rows.reduce((m: string, r: any) => (r.updated_at && String(r.updated_at) > m ? String(r.updated_at) : m), "") || null;

  return {
    art: "sales",
    // zeitraum bleibt (Rückwärtskompatibilität); tage = Tage MIT Daten, nicht Kalendertage.
    zeitraum: { von, bis, tage: analyse.tage_mit_daten },
    angefragter_zeitraum: analyse.angefragt,
    verfuegbarer_zeitraum: analyse.verfuegbar,
    latest_available_date: analyse.latest_available_date,
    tage_mit_daten: analyse.tage_mit_daten,
    fehlende_tage: analyse.fehlende_tage,
    fehlende_tage_anzahl: analyse.fehlende_tage_anzahl,
    is_provisional: analyse.is_provisional,
    warnungen: analyse.warnungen,
    data_timestamp,
    gesamt,
    monatlich,
    quelle: "sales_daily (Verlauf)",
  };
}

// --- Orders (aus orders_history) ---

export async function ordersRange(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const { von, bis } = zeitraum(args);
  const rows = await alleZeilen(supabase, "orders_history", tenant_id, "purchase_date", von, bisExklusiv(bis));
  if (rows.length === 0) {
    return { keine_daten: true, art: "orders", zeitraum: { von, bis }, hinweis: "Keine Orders-Historie im Zeitraum." };
  }

  // Zurück in die Flat-File-Zeilenform, die baueOrdersOverview erwartet.
  const payload = {
    rows: rows.map((r) => ({
      "amazon-order-id": r.amazon_order_id ?? "",
      "sku": r.sku ?? "",
      "asin": r.asin ?? "",
      "quantity": String(r.quantity ?? 0),
      "item-price": r.item_price_cents == null ? "" : (r.item_price_cents / 100).toFixed(2),
      "currency": r.currency ?? "",
      "sales-channel": r.sales_channel ?? "",
      "order-status": r.order_status ?? "",
      "purchase-date": r.purchase_date ?? "",
    })),
  };
  const ov = baueOrdersOverview(payload, new Date().toISOString(), false) as any;
  // Zeitraum auf die ANGEFRAGTE Spanne setzen (nicht den min/max der Zeilen).
  ov.zeitraum = { von, bis };
  ov.quelle = "orders_history (Verlauf)";
  return ov;
}

// --- Orders-basierter Umsatz (tagesaktuell, aus orders_history) ---

export interface OrdersTag {
  datum: string;
  umsatz_cents: number;
  einheiten: number;
  zeilen: number;
  zeilen_ohne_preis: number;
}

/**
 * Baut aus Tages-Aggregaten (RPC orders_umsatz_taeglich) die Monatsreihe + Gesamt.
 * Rein & testbar. Ehrlichkeit: fehlende Preise -> Umsatz ist eine Untergrenze;
 * Pending/laufender Tag können sich noch ändern.
 */
export function baueOrdersUmsatz(tage: OrdersTag[], von: string, waehrung = "EUR"): Record<string, unknown> {
  let umsatzC = 0, einheiten = 0, zeilen = 0, ohnePreis = 0;
  const proMonat = new Map<string, { umsatz_cents: number; units: number }>();
  for (const t of tage) {
    const uc = Number(t.umsatz_cents) || 0;
    umsatzC += uc;
    einheiten += Number(t.einheiten) || 0;
    zeilen += Number(t.zeilen) || 0;
    ohnePreis += Number(t.zeilen_ohne_preis) || 0;
    const monat = String(t.datum).slice(0, 7);
    const e = proMonat.get(monat) ?? { umsatz_cents: 0, units: 0 };
    e.umsatz_cents += uc;
    e.units += Number(t.einheiten) || 0;
    proMonat.set(monat, e);
  }
  // Angeschnittenen Startmonat weglassen (wie bei salesRange), sonst Stummel-Balken.
  const vonMonat = von.slice(0, 7);
  const startAngeschnitten = von.slice(8, 10) !== "01";
  const monatlich = [...proMonat]
    .filter(([m]) => !(startAngeschnitten && m === vonMonat))
    .map(([monat, e]) => ({ monat, umsatz: Math.round(e.umsatz_cents) / 100, units: e.units }));

  const preis_abdeckung = zeilen > 0 ? Math.round(((zeilen - ohnePreis) / zeilen) * 1000) / 10 : null;
  const warnungen: string[] = [];
  if (ohnePreis > 0) warnungen.push(`${ohnePreis} Bestellzeilen ohne Preis (z. B. in Zustellung) — der Umsatz ist eine Untergrenze.`);
  warnungen.push("Tagesaktuell inkl. Pending, ohne Stornos (Tag-Grenze Europe/Berlin). Der laufende Tag und offene Bestellungen können sich noch ändern.");

  return {
    gesamt: {
      umsatz: Math.round(umsatzC) / 100,
      einheiten, zeilen, zeilen_ohne_preis: ohnePreis,
      preis_abdeckung, waehrung,
    },
    monatlich,
    warnungen,
    is_provisional: true, // Orders sind naturgemäß in Bewegung (Pending, laufender Tag)
  };
}

export async function ordersUmsatzRange(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const { von, bis } = zeitraum(args);
  const { data, error } = await supabase.rpc("orders_umsatz_taeglich", { p_tenant: tenant_id, p_von: von, p_bis: bis });
  if (error) throw new Error(`orders_umsatz: ${error.message}`);
  const tage = (data ?? []) as OrdersTag[];
  if (tage.length === 0) {
    return { keine_daten: true, art: "orders_umsatz", zeitraum: { von, bis }, hinweis: "Keine Bestellungen im Zeitraum." };
  }
  return {
    art: "orders_umsatz",
    zeitraum: { von, bis },
    ...baueOrdersUmsatz(tage, von),
    quelle: "orders_history (tagesaktuell, Europe/Berlin, ohne Storno)",
  };
}

// --- Returns (aus returns_history) ---

export async function returnsRange(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const { von, bis } = zeitraum(args);
  const rows = await alleZeilen(supabase, "returns_history", tenant_id, "return_request_date", von, bisExklusiv(bis));
  if (rows.length === 0) {
    return { keine_daten: true, art: "returns", zeitraum: { von, bis }, hinweis: "Keine Retouren-Historie im Zeitraum." };
  }
  // Die Roh-Zeile wurde beim Ingest als jsonb gesichert -> direkt wiederverwenden.
  const payload = { rows: rows.map((r) => r.raw ?? {}) };
  const ov = baueReturnsOverview(payload, new Date().toISOString()) as any;
  ov.zeitraum = { von, bis };
  ov.quelle = "returns_history (Verlauf)";
  return ov;
}

/** Retouren-Übersicht aus den NORMALISIERTEN returns_history-Spalten (FBM UND FBA).
 *  baueReturnsOverview parst nur das FBM-Rohformat — bei FBA-Händlern zeigt der
 *  Overview-Tab sonst leer. Hier tolerant über beide Quellen, gleiche Ausgabeform. */
export async function returnsVerlaufUebersicht(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const { von, bis } = zeitraum(args);
  const asinFilter = typeof args?.asin === "string" && args.asin.trim() ? args.asin.trim() : null;

  // Retouren + verkaufte Einheiten je ASIN (für die Retourenquote in % vom Verkauf).
  const [rows, prodRes] = await Promise.all([
    alleZeilen(supabase, "returns_history", tenant_id, "return_request_date", von, bisExklusiv(bis)),
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
  ]);
  const verkauft = new Map<string, { name: string; einheiten: number }>();
  for (const p of prodRes.data ?? []) {
    verkauft.set(p.asin, { name: p.produktname ?? p.asin, einheiten: Number(p.einheiten) || 0 });
  }

  const proAsin = new Map<string, { asin: string; name: string; retouren: number; einheiten: number }>();
  const proGrund = new Map<string, number>(); // je nach Filter: eine ASIN oder alle
  let retouren = 0, einheiten = 0, erstattetCents = 0, erstattetBekannt = false;
  let waehrung: string | null = null;

  for (const r of rows) {
    const asin = (r.asin && String(r.asin).trim()) || "—";
    const menge = Number(r.return_quantity) || 1;

    // Je ASIN IMMER (unabhängig vom Filter) — für Tabelle + Auswahl.
    const ea = proAsin.get(asin) ?? { asin, name: verkauft.get(asin)?.name ?? ((r.item_name && String(r.item_name)) || asin), retouren: 0, einheiten: 0 };
    ea.retouren += 1; ea.einheiten += menge;
    proAsin.set(asin, ea);

    // Gründe + Gesamt: auf die gewählte ASIN beziehen (sonst global).
    if (!asinFilter || asin === asinFilter) {
      retouren += 1; einheiten += menge;
      if (r.refunded_cents != null) { erstattetCents += Number(r.refunded_cents) || 0; erstattetBekannt = true; }
      if (!waehrung && r.currency) waehrung = String(r.currency);
      const grund = (r.return_reason && String(r.return_reason).trim()) || "Unbekannt";
      proGrund.set(grund, (proGrund.get(grund) ?? 0) + 1);
    }
  }

  const nach_asin = [...proAsin.values()].map((a) => {
    const vk = verkauft.get(a.asin)?.einheiten ?? 0;
    // Retourenquote = zurückgesandte Einheiten / verkaufte Einheiten.
    return { ...a, verkauft: vk, retourenquote: vk > 0 ? Math.round((a.einheiten / vk) * 1000) / 10 : null };
  }).sort((a, b) => b.retouren - a.retouren);

  return {
    zeitraum: { von, bis },
    unvalidiert: false,
    warnungen: [] as string[],
    asin_filter: asinFilter,
    gesamt: {
      retouren, einheiten,
      erstattet_bekannt: erstattetBekannt ? Math.round(erstattetCents) / 100 : null,
      waehrung: waehrung ?? "EUR",
    },
    nach_grund: [...proGrund].map(([grund, r]) => ({ grund, retouren: r })).sort((a, b) => b.retouren - a.retouren),
    nach_asin,
    asins: nach_asin.map((a) => ({ asin: a.asin, name: a.name })),
    quelle: "returns_history + produkt_uebersicht",
  };
}

/** Dispatch für die McpContext.ladeVerlauf-Verdrahtung in api/mcp. */
export function ladeVerlaufFactory(supabase: any, tenant_id: string) {
  return async (art: VerlaufArt, args: any): Promise<unknown> => {
    if (art === "sales") return salesRange(supabase, tenant_id, args);
    if (art === "orders") return ordersRange(supabase, tenant_id, args);
    if (art === "orders_umsatz") return ordersUmsatzRange(supabase, tenant_id, args);
    if (art === "returns") return returnsRange(supabase, tenant_id, args);
    throw new Error(`Unbekannte Verlaufs-Art: ${art}`);
  };
}

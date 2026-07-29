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

export type VerlaufArt = "sales" | "orders" | "returns";

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

  return {
    art: "sales",
    zeitraum: { von, bis, tage: rows.length },
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
  const rows = await alleZeilen(supabase, "returns_history", tenant_id, "return_request_date", von, bisExklusiv(bis));

  let retouren = 0, einheiten = 0, erstattetCents = 0, erstattetBekannt = false;
  let waehrung: string | null = null;
  const proGrund = new Map<string, number>();
  const proAsin = new Map<string, { asin: string; name: string; retouren: number; einheiten: number }>();

  for (const r of rows) {
    const menge = Number(r.return_quantity) || 1;
    retouren += 1;
    einheiten += menge;
    if (r.refunded_cents != null) { erstattetCents += Number(r.refunded_cents) || 0; erstattetBekannt = true; }
    if (!waehrung && r.currency) waehrung = String(r.currency);
    const grund = (r.return_reason && String(r.return_reason).trim()) || "Unbekannt";
    proGrund.set(grund, (proGrund.get(grund) ?? 0) + 1);
    const asin = (r.asin && String(r.asin).trim()) || "—";
    const e = proAsin.get(asin) ?? { asin, name: (r.item_name && String(r.item_name)) || asin, retouren: 0, einheiten: 0 };
    e.retouren += 1; e.einheiten += menge;
    proAsin.set(asin, e);
  }

  return {
    zeitraum: { von, bis },
    unvalidiert: false,
    warnungen: [] as string[],
    gesamt: {
      retouren, einheiten,
      erstattet_bekannt: erstattetBekannt ? Math.round(erstattetCents) / 100 : null,
      waehrung: waehrung ?? "EUR",
    },
    nach_grund: [...proGrund].map(([grund, r]) => ({ grund, retouren: r })).sort((a, b) => b.retouren - a.retouren),
    nach_asin: [...proAsin.values()].sort((a, b) => b.retouren - a.retouren),
    quelle: "returns_history (normalisiert, FBM+FBA)",
  };
}

/** Dispatch für die McpContext.ladeVerlauf-Verdrahtung in api/mcp. */
export function ladeVerlaufFactory(supabase: any, tenant_id: string) {
  return async (art: VerlaufArt, args: any): Promise<unknown> => {
    if (art === "sales") return salesRange(supabase, tenant_id, args);
    if (art === "orders") return ordersRange(supabase, tenant_id, args);
    if (art === "returns") return returnsRange(supabase, tenant_id, args);
    throw new Error(`Unbekannte Verlaufs-Art: ${art}`);
  };
}

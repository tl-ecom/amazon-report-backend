// overview.ts — Pulse Overview (Modul 1): "Was passiert gerade im Account?"
// Kombiniert die vorhandenen Aggregatoren (Sales & Traffic, Listings) + die
// jüngsten Change Events zu einer entscheidungsfokussierten Übersicht:
// Ampel-Status, Top-KPIs, max. 3 priorisierte Prüfungen, auffällige ASINs.
//
// Die Hinweis-Ableitung (baueHinweise) und die Ampel (ampelStatus) sind rein und
// unit-getestet. Sie behaupten KEINE Ursache — sie benennen Prüf-Kandidaten.

import { baueOverview } from "./metrics.ts";
import { baueListingsOverview } from "./listings.ts";

const SALES_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";
const LISTINGS_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const SESSIONS_MIN = 30; // Schwelle, ab der "Traffic" als aussagekräftig gilt

export interface Hinweis {
  typ: string;
  prioritaet: "kritisch" | "hoch" | "mittel" | "niedrig";
  text: string;
  asin?: string;
}

const PRIO_RANG: Record<Hinweis["prioritaet"], number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 };

/** Leitet aus Sales-Overview + Listings-Overview deterministische Prüf-Hinweise ab. */
export function baueHinweise(sales: any, listings: any): Hinweis[] {
  const hinweise: Hinweis[] = [];
  const accCvr: number | null = sales?.gesamt?.cvrUnitSession ?? null;
  const proAsin: any[] = sales?.proAsin ?? [];

  const top = proAsin[0];
  if (top && top.umsatzAnteil != null && top.umsatzAnteil > 50) {
    hinweise.push({ typ: "umsatzkonzentration", prioritaet: "mittel", asin: top.childAsin, text: `Der Umsatz hängt stark an einer ASIN (${top.childAsin}: ${top.umsatzAnteil} %).` });
  }

  for (const a of proAsin) {
    const sessions = Number(a.sessions) || 0;
    const units = Number(a.unitsOrdered) || 0;
    const cvr = a.cvrUnitSession;
    if (sessions >= SESSIONS_MIN && units === 0) {
      hinweise.push({ typ: "traffic_ohne_verkauf", prioritaet: "hoch", asin: a.childAsin, text: `${a.childAsin}: ${sessions} Sessions, aber 0 Verkäufe.` });
    } else if (accCvr && sessions >= SESSIONS_MIN && cvr != null && cvr < accCvr * 0.5) {
      hinweise.push({ typ: "conversion_unter_schnitt", prioritaet: "mittel", asin: a.childAsin, text: `${a.childAsin}: CVR ${cvr} % — deutlich unter Account-Schnitt (${accCvr} %).` });
    }
    if (accCvr && cvr != null && cvr > accCvr && sessions > 0 && sessions < SESSIONS_MIN) {
      hinweise.push({ typ: "gute_cvr_wenig_traffic", prioritaet: "niedrig", asin: a.childAsin, text: `${a.childAsin}: gute CVR (${cvr} %) bei wenig Traffic (${sessions} Sessions) — Potenzial für mehr Reichweite.` });
    }
  }

  const ausverkauft = Number(listings?.bestand_merchant?.ausverkauft) || 0;
  if (ausverkauft > 0) {
    hinweise.push({ typ: "fbm_ohne_bestand", prioritaet: "kritisch", text: `${ausverkauft} aktive Merchant-Angebote ohne Bestand — live, aber nicht verkaufsfähig.` });
  }

  return hinweise.sort((a, b) => PRIO_RANG[a.prioritaet] - PRIO_RANG[b.prioritaet]);
}

/** Ampel aus den Hinweisen: kritisch→rot, hoch/mittel→gelb, sonst grün. */
export function ampelStatus(hinweise: Hinweis[]): "rot" | "gelb" | "gruen" {
  if (hinweise.some((h) => h.prioritaet === "kritisch")) return "rot";
  if (hinweise.some((h) => h.prioritaet === "hoch" || h.prioritaet === "mittel")) return "gelb";
  return "gruen";
}

async function ladeLatest(supabase: any, tenant_id: string, reportType: string): Promise<any | null> {
  const { data } = await supabase
    .from("report_data")
    .select("payload, data_timestamp, is_provisional")
    .eq("tenant_id", tenant_id).eq("source", "sp").eq("report_type", reportType).eq("is_latest", true)
    .maybeSingle();
  return data ?? null;
}

export async function pulseOverview(supabase: any, tenant_id: string): Promise<unknown> {
  const [salesRow, listingsRow, changesRes] = await Promise.all([
    ladeLatest(supabase, tenant_id, SALES_TYPE),
    ladeLatest(supabase, tenant_id, LISTINGS_TYPE),
    supabase.from("change_events").select("asin, event_type, previous_value, new_value, relevance, effective_at, status")
      .eq("tenant_id", tenant_id).order("detected_at", { ascending: false }).limit(5),
  ]);

  const sales = salesRow ? baueOverview(salesRow.payload, salesRow.data_timestamp, salesRow.is_provisional) as any : null;
  const listings = listingsRow ? baueListingsOverview(listingsRow.payload, listingsRow.data_timestamp) as any : null;

  const hinweise = baueHinweise(sales, listings);
  const status = ampelStatus(hinweise);

  const g = sales?.gesamt ?? {};
  return {
    status,
    zeitraum: sales?.zeitraum ?? null,
    data_timestamp: sales?.data_timestamp ?? listings?.data_timestamp ?? null,
    is_provisional: sales?.is_provisional ?? false,
    kpis: {
      umsatz: g.umsatzOrdered ?? null,
      waehrung: g.waehrung ?? null,
      sessions: g.sessions ?? null,
      pageViews: g.pageViews ?? null,
      unitsOrdered: g.unitsOrdered ?? null,
      cvr: g.cvrUnitSession ?? null,
      durchschnittspreis: g.durchschnittspreis ?? null,
      retourenquote: g.retourenquote ?? null,
    },
    listings: listings ? {
      aktiv: listings.gesamt?.aktiv ?? null,
      inaktiv: listings.gesamt?.inaktiv ?? null,
      ausverkauft: listings.bestand_merchant?.ausverkauft ?? null,
      preis_min: listings.preis_aktiv?.min ?? null,
      preis_max: listings.preis_aktiv?.max ?? null,
    } : null,
    pruefungen: hinweise.slice(0, 3),
    top_changes: changesRes.data ?? [],
    warnungen: sales?.konsistenz && !sales.konsistenz.ok ? ["Sales-Daten: byDate und byAsin weichen ab — Zahlen prüfen."] : [],
    datenqualitaet: {
      sales_vorhanden: Boolean(sales),
      listings_vorhanden: Boolean(listings),
    },
  };
}

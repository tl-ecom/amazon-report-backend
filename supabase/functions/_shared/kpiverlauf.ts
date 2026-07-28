// kpiverlauf.ts — Monatlicher KPI-Verlauf aus sales_daily. Liefert je Monat die
// Kennzahlen, die wir HEUTE ehrlich haben: Umsatz, verkaufte Einheiten, Sessions,
// Conversion Rate, Retourenquote, Page Views. (Nettogewinn/Marge kommen erst mit
// EK-Kosten, Ads-KPIs erst mit der Ads-API — bewusst NICHT hier gefaked.)
//
// aggregiereMonate(...) ist rein & unit-getestet.

interface TagesZeile {
  datum: string;
  sessions: number | null;
  page_views: number | null;
  units_ordered: number | null;
  units_refunded: number | null;
  ordered_sales_cents: number | null;
}

export interface MonatsKpi {
  monat: string; // YYYY-MM
  umsatz: number; // in Währungseinheiten (aus Cents)
  einheiten: number;
  sessions: number;
  pageViews: number;
  cvr: number | null; // % (Einheiten / Sessions)
  retourenquote: number | null; // % (Retouren / Einheiten)
}

function runde(n: number, stellen = 2): number {
  const f = 10 ** stellen;
  return Math.round(n * f) / f;
}

/** Summiert Tageszeilen zu Monatswerten (aufsteigend sortiert). Rein. */
export function aggregiereMonate(rows: TagesZeile[]): MonatsKpi[] {
  const acc = new Map<string, { umsatzC: number; einheiten: number; sessions: number; pageViews: number; refunds: number }>();
  for (const r of rows ?? []) {
    const monat = (r.datum ?? "").slice(0, 7);
    if (!monat) continue;
    const m = acc.get(monat) ?? { umsatzC: 0, einheiten: 0, sessions: 0, pageViews: 0, refunds: 0 };
    m.umsatzC += Number(r.ordered_sales_cents) || 0;
    m.einheiten += Number(r.units_ordered) || 0;
    m.sessions += Number(r.sessions) || 0;
    m.pageViews += Number(r.page_views) || 0;
    m.refunds += Number(r.units_refunded) || 0;
    acc.set(monat, m);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monat, m]) => ({
      monat,
      umsatz: runde(m.umsatzC / 100),
      einheiten: m.einheiten,
      sessions: m.sessions,
      pageViews: m.pageViews,
      cvr: m.sessions > 0 ? runde((m.einheiten / m.sessions) * 100) : null,
      retourenquote: m.einheiten > 0 ? runde((m.refunds / m.einheiten) * 100) : null,
    }));
}

export async function kpiVerlauf(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("sales_daily")
    .select("datum, sessions, page_views, units_ordered, units_refunded, ordered_sales_cents, waehrung")
    .eq("tenant_id", tenant_id).order("datum", { ascending: true });
  if (error) throw new Error(`sales_daily read: ${error.message}`);
  const rows = data ?? [];
  return {
    monate: aggregiereMonate(rows),
    waehrung: rows[0]?.waehrung ?? "EUR",
  };
}

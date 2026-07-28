// sqp.ts — Parser für den Brand-Analytics Search Query Performance Report
// (GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT, ASIN-gefiltert).
// Rechnet je Suchanfrage: eigene CTR/CVR vs. Markt-CTR/CVR (+ Index) und den
// Kaufanteil der ASIN. "duenn" markiert Zeilen mit zu kleiner eigener Datenbasis.

const DUENN_IMPRESSIONS = 100; // eigene Impressions darunter => dünne Datenbasis
const DUENN_CLICKS = 10;

function quote(zaehler: number, nenner: number): number | null {
  if (!nenner || nenner <= 0) return null;
  return zaehler / nenner; // Rohquotient (0..1)
}
function alsProzent(q: number | null): number | null {
  return q == null ? null : Math.round(q * 1000) / 10; // % mit 1 Nachkommastelle
}
function index(eigen: number | null, markt: number | null): number | null {
  // WICHTIG: aus den Rohquotienten, nicht aus gerundeten Prozenten.
  if (eigen == null || markt == null || markt <= 0) return null;
  return Math.round((eigen / markt) * 100) / 100;
}
function n(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

export interface SqpZeile {
  search_query: string;
  volume: number;
  eigene_ctr: number | null;
  markt_ctr: number | null;
  ctr_index: number | null;
  eigene_cvr: number | null;
  markt_cvr: number | null;
  cvr_index: number | null;
  kaufanteil: number | null; // % Anteil der ASIN an allen Käufen der Suchanfrage
  duenn: boolean;
}

/** Parst den ASIN-gefilterten SQP-Report zu Zeilen je Suchanfrage. Rein. */
export function parseSqpReport(report: any): SqpZeile[] {
  const rows: any[] = report?.dataByAsin ?? report?.dataByDepartmentAndSearchTerm ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const q = r?.searchQueryData ?? {};
    const imp = r?.impressionData ?? {};
    const clk = r?.clickData ?? {};
    const pur = r?.purchaseData ?? {};

    const asinImpr = n(imp.asinImpressionCount);
    const totalImpr = n(imp.totalQueryImpressionCount);
    const asinClicks = n(clk.asinClickCount);
    const totalClicks = n(clk.totalClickCount);
    const asinPurch = n(pur.asinPurchaseCount);
    const totalPurch = n(pur.totalPurchaseCount);

    const eigeneCtrQ = quote(asinClicks, asinImpr);
    const marktCtrQ = quote(totalClicks, totalImpr);
    const eigeneCvrQ = quote(asinPurch, asinClicks);
    const marktCvrQ = quote(totalPurch, totalClicks);
    const kaufanteil = typeof pur.asinPurchaseShare === "number"
      ? Math.round(pur.asinPurchaseShare * 1000) / 10
      : alsProzent(quote(asinPurch, totalPurch));

    return {
      search_query: String(q.searchQuery ?? ""),
      volume: n(q.searchQueryVolume),
      eigene_ctr: alsProzent(eigeneCtrQ), markt_ctr: alsProzent(marktCtrQ), ctr_index: index(eigeneCtrQ, marktCtrQ),
      eigene_cvr: alsProzent(eigeneCvrQ), markt_cvr: alsProzent(marktCvrQ), cvr_index: index(eigeneCvrQ, marktCvrQ),
      kaufanteil,
      duenn: asinImpr < DUENN_IMPRESSIONS || asinClicks < DUENN_CLICKS,
    };
  }).filter((z) => z.search_query !== "");
}

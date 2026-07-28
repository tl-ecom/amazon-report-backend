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
    // Kaufanteil aus Zählwerten (asinPurchaseShare ist uneinheitlich skaliert).
    const kaufanteil = alsProzent(quote(asinPurch, totalPurch));

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

/** Gespeicherte SQP-Zeilen einer ASIN (Volumen absteigend). */
export async function listeSqp(supabase: any, tenant_id: string, asin: string): Promise<unknown> {
  if (!asin) return { rows: [], zeitraum: null };
  const { data, error } = await supabase.from("sqp_rows")
    .select("search_query, volume, eigene_ctr, markt_ctr, ctr_index, eigene_cvr, markt_cvr, cvr_index, kaufanteil, duenn, zeitraum_von, zeitraum_bis")
    .eq("tenant_id", tenant_id).eq("asin", asin).order("volume", { ascending: false });
  if (error) throw new Error(`sqp read: ${error.message}`);
  const rows = data ?? [];
  const zeitraum = rows[0] ? { von: rows[0].zeitraum_von, bis: rows[0].zeitraum_bis } : null;
  return { rows, zeitraum };
}

/** Verkaufte ASINs (für die Auswahl) + Flag, ob schon SQP-Daten vorliegen. */
export async function sqpAsins(supabase: any, tenant_id: string): Promise<unknown> {
  const [ordersRes, sqpRes, asinsRes] = await Promise.all([
    supabase.from("orders_history").select("asin, quantity").eq("tenant_id", tenant_id),
    supabase.from("sqp_rows").select("asin").eq("tenant_id", tenant_id),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
  ]);
  const units = new Map<string, number>();
  for (const o of ordersRes.data ?? []) if (o.asin) units.set(o.asin, (units.get(o.asin) ?? 0) + (Number(o.quantity) || 0));
  const mitDaten = new Set<string>((sqpRes.data ?? []).map((r: any) => String(r.asin)));
  const titel = new Map<string, string>((asinsRes.data ?? []).map((a: any) => [String(a.asin), String(a.produktname ?? a.asin)]));

  const asins = [...units.entries()].map(([asin, u]) => ({ asin, titel: titel.get(asin) ?? asin, units: u, hat_daten: mitDaten.has(asin) }));
  for (const a of mitDaten) if (!units.has(a)) asins.push({ asin: a, titel: titel.get(a) ?? a, units: 0, hat_daten: true });
  asins.sort((x, y) => (Number(y.hat_daten) - Number(x.hat_daten)) || (y.units - x.units));
  return { asins };
}

/** SQP-Report für eine ASIN asynchron anstoßen (läuft ~1–2 Min im Hintergrund). */
export async function anstossenSqp(supabase: any, tenant_id: string, asin: string): Promise<{ ok: true }> {
  if (!asin) throw new Error("asin fehlt");
  const { error } = await supabase.rpc("sqp_anstossen", { p_tenant: tenant_id, p_asin: asin });
  if (error) throw new Error(`sqp_anstossen: ${error.message}`);
  return { ok: true };
}

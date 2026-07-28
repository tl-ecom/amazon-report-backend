// experiments.ts — Experimente aus bestätigten Change Events + Vorher/Nachher-
// Auswertung. Die Auswertung wird beim LESEN aus der vorhandenen Historie
// (sales_daily, orders_history) gerechnet — deterministisch und EHRLICH:
//   * keine Kausalitätsbehauptung (§4.5)
//   * bei zu wenig Daten explizit "Datenmenge zu gering"
//   * vorläufige (letzte ~2 Tage) Fenster werden markiert
//   * Konto- vs. ASIN-Ebene getrennt ausgewiesen (nicht vermischen)
//
// Reine Datumshelfer sind ausgelagert und unit-getestet (reviewDaten, deltaPct).

export function addTage(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function reviewDaten(start: string): { review_7: string; review_14: string; review_30: string } {
  return { review_7: addTage(start, 7), review_14: addTage(start, 14), review_30: addTage(start, 30) };
}

export function deltaPct(vorher: number, nachher: number): number | null {
  if (!vorher) return null; // Division durch 0 -> keine Aussage (nicht 0/Infinity)
  return Math.round(((nachher - vorher) / Math.abs(vorher)) * 1000) / 10;
}

const FENSTER = [7, 14, 30];

/** Legt aus einem bestätigten "geplanter Test"-Event ein Experiment an (idempotent). */
export async function erstelleExperiment(
  supabase: any,
  tenant_id: string,
  ev: { id: string; asin: string | null; seller_sku: string | null; effective_at: string | null },
  ctx: { hypothesis?: string; target_metric?: string; target_value?: string; user_id?: string },
): Promise<void> {
  const start = ev.effective_at ?? new Date().toISOString().slice(0, 10);
  const r = reviewDaten(start);
  await supabase.from("experiments").upsert({
    tenant_id,
    asin: ev.asin,
    seller_sku: ev.seller_sku,
    change_event_id: ev.id,
    hypothesis: ctx.hypothesis ?? null,
    target_metric: ctx.target_metric ?? null,
    target_value: ctx.target_value ?? null,
    start_date: start,
    review_7: r.review_7,
    review_14: r.review_14,
    review_30: r.review_30,
    responsible_user_id: ctx.user_id ?? null,
    status: "aktiv",
  }, { onConflict: "change_event_id" });
}

export async function listeExperimente(supabase: any, tenant_id: string, args: { status?: string; limit?: number } = {}): Promise<unknown> {
  let q = supabase.from("experiments").select("*").eq("tenant_id", tenant_id).order("start_date", { ascending: false }).limit(Math.min(Number(args.limit ?? 100), 500));
  if (args.status) q = q.eq("status", args.status);
  const { data, error } = await q;
  if (error) throw new Error(`experiments: ${error.message}`);
  return { experiments: data ?? [] };
}

/** Experiment + Vorher/Nachher-Auswertung. */
export async function experimentDetail(supabase: any, tenant_id: string, args: { id?: string } = {}): Promise<unknown> {
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error("id fehlt");
  const { data: exp, error } = await supabase.from("experiments").select("*").eq("tenant_id", tenant_id).eq("id", id).maybeSingle();
  if (error) throw new Error(`experiments: ${error.message}`);
  if (!exp) throw new Error("Experiment nicht gefunden.");
  const auswertung = await auswerten(supabase, tenant_id, exp);
  return { experiment: exp, auswertung };
}

interface FensterErgebnis {
  fenster: number;
  vorlaeufig: boolean;
  konto: { umsatz_v: number; umsatz_n: number; umsatz_pct: number | null; sessions_v: number; sessions_n: number; cvr_v: number | null; cvr_n: number | null };
  asin: { units_v: number; units_n: number; units_pct: number | null; umsatz_v: number; umsatz_n: number; umsatz_pct: number | null } | null;
}

async function auswerten(supabase: any, tenant_id: string, exp: any): Promise<{ fenster: FensterErgebnis[]; hinweise: string[] }> {
  const start: string = String(exp.start_date).slice(0, 10);
  const von = addTage(start, -30);
  const bis = addTage(start, 30);
  const heute = new Date().toISOString().slice(0, 10);

  // Datensätze EINMAL laden, dann Fenster in memory bilden.
  const { data: sd } = await supabase.from("sales_daily").select("datum, sessions, units_ordered, ordered_sales_cents").eq("tenant_id", tenant_id).gte("datum", von).lte("datum", bis);
  let od: any[] = [];
  if (exp.asin) {
    const r = await supabase.from("orders_history").select("purchase_date, quantity, item_price_cents").eq("tenant_id", tenant_id).eq("asin", exp.asin).gte("purchase_date", von).lte("purchase_date", bis + "T23:59:59Z");
    od = r.data ?? [];
  }
  const salesRows = sd ?? [];

  const inFenster = (datum: string, a: string, b: string) => datum >= a && datum < b;

  const kontoSum = (a: string, b: string) => {
    let sessions = 0, units = 0, cents = 0;
    for (const r of salesRows) if (inFenster(String(r.datum), a, b)) { sessions += Number(r.sessions) || 0; units += Number(r.units_ordered) || 0; cents += Number(r.ordered_sales_cents) || 0; }
    return { sessions, units, umsatz: Math.round(cents) / 100 };
  };
  const asinSum = (a: string, b: string) => {
    let units = 0, cents = 0;
    for (const r of od) { const d = String(r.purchase_date).slice(0, 10); if (inFenster(d, a, b)) { units += Number(r.quantity) || 0; if (r.item_price_cents != null) cents += Number(r.item_price_cents); } }
    return { units, umsatz: Math.round(cents) / 100 };
  };

  const cvr = (units: number, sessions: number) => (sessions ? Math.round((units / sessions) * 1000) / 10 : null);

  const fenster: FensterErgebnis[] = FENSTER.map((f) => {
    const vorA = addTage(start, -f), vorB = start;
    const nachA = start, nachB = addTage(start, f);
    const kv = kontoSum(vorA, vorB), kn = kontoSum(nachA, nachB);
    const av = exp.asin ? asinSum(vorA, vorB) : null;
    const an = exp.asin ? asinSum(nachA, nachB) : null;
    return {
      fenster: f,
      vorlaeufig: nachB > addTage(heute, -2), // reicht ins volatile Fenster
      konto: {
        umsatz_v: kv.umsatz, umsatz_n: kn.umsatz, umsatz_pct: deltaPct(kv.umsatz, kn.umsatz),
        sessions_v: kv.sessions, sessions_n: kn.sessions,
        cvr_v: cvr(kv.units, kv.sessions), cvr_n: cvr(kn.units, kn.sessions),
      },
      asin: av && an ? {
        units_v: av.units, units_n: an.units, units_pct: deltaPct(av.units, an.units),
        umsatz_v: av.umsatz, umsatz_n: an.umsatz, umsatz_pct: deltaPct(av.umsatz, an.umsatz),
      } : null,
    };
  });

  const hinweise: string[] = [
    "Vorher/Nachher zeigt Veränderung, KEINE Kausalität — externe Faktoren (Preis, PPC, Saison, Wettbewerb) können mitwirken.",
  ];
  const f7 = fenster[0];
  const kleineDaten = f7.konto.sessions_v + f7.konto.sessions_n < 100 || (f7.asin ? (f7.asin.units_v + f7.asin.units_n) < 10 : false);
  if (kleineDaten) hinweise.push("Datenmenge im 7-Tage-Fenster gering — Aussage noch nicht belastbar.");
  if (fenster.some((x) => x.vorlaeufig)) hinweise.push("Ein Fenster reicht in die letzten ~2 Tage — diese Werte sind vorläufig.");
  if (exp.asin) hinweise.push("ASIN-Ebene (Absatz/Umsatz aus Orders) und Konto-Ebene (Sessions/CVR aus Sales & Traffic) sind getrennt ausgewiesen — nicht vermischen.");

  return { fenster, hinweise };
}

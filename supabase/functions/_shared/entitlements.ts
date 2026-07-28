// entitlements.ts — Feature-Gating je Tarif (§23). Zentrale Stelle: welche
// api-Ressource/Aktion hängt an welchem Feature-Key (= Tab-ID der Matrix).
// zugriffErlaubt(...) ist rein & getestet; ladeFeatures(...) holt die Flags.
//
// Nicht aufgeführte Ressourcen (pulse_overview, connect, admin_*, mein_konto)
// sind IMMER erlaubt. Admins/Coaches umgehen das Gating komplett.

export const RESOURCE_FEATURE: Record<string, string> = {
  // Reads
  diagnosen: "diagnosen",
  tasks: "tasks",
  weekly_briefs: "brief",
  fr_change_events: "aenderungen",
  fr_asin_timeline: "aenderungen",
  fr_experiments: "experimente",
  fr_experiment_detail: "experimente",
  get_sales_history: "verlauf",
  get_orders_history: "verlauf",
  get_returns_history: "verlauf",
  kpi_verlauf: "verlauf",
  ertrag_verlauf: "verlauf",
  asin_ek: "verlauf",
  ek_setzen: "verlauf",
  ek_loeschen: "verlauf",
  einstellungen: "verlauf",
  einstellungen_setzen: "verlauf",
  get_sales_overview: "sales",
  get_orders_overview: "orders",
  get_listings_overview: "listings",
  get_ads_overview: "ads",
  get_returns_overview: "returns",
  get_product_performance: "products",
  produkt_uebersicht: "products",
  sqp: "sqp",
  sqp_asins: "sqp",
  sqp_laden: "sqp",
  coaching_notes: "notes",
  // Aktionen
  note_erstellen: "notes",
  note_sichtbarkeit: "notes",
  note_loeschen: "notes",
  diagnosen_aktualisieren: "diagnosen",
  diagnose_status: "diagnosen",
  task_erstellen: "tasks",
  task_aus_diagnose: "tasks",
  task_status: "tasks",
  brief_generieren: "brief",
  brief_notiz: "brief",
  fr_set_context: "aenderungen",
};

/** Reine Zugriffsentscheidung. Admins immer erlaubt; ungelistete Keys immer erlaubt;
 * sonst muss das Feature im Tarif aktiv sein. */
export function zugriffErlaubt(
  key: string | undefined,
  features: Record<string, boolean> | null,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  if (!key) return true;
  const feat = RESOURCE_FEATURE[key];
  if (!feat) return true; // ungated
  return Boolean(features?.[feat]);
}

/** Feature-Flags für den Tarif einer Firma laden (leer, wenn nichts konfiguriert). */
export async function ladeFeatures(supabase: any, tenantId: string): Promise<Record<string, boolean>> {
  const { data: t } = await supabase.from("tenants").select("tarif").eq("id", tenantId).maybeSingle();
  const tarif = t?.tarif ?? "premium";
  const { data: tf } = await supabase.from("tarif_features").select("features").eq("tarif", tarif).maybeSingle();
  return (tf?.features ?? {}) as Record<string, boolean>;
}

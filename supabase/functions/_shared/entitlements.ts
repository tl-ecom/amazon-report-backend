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
  fr_produkte: "aenderungen",
  fr_experiments: "experimente",
  fr_experiment_detail: "experimente",
  get_sales_history: "verlauf",
  get_orders_history: "verlauf",
  get_orders_revenue: "verlauf",
  get_returns_history: "verlauf",
  kpi_verlauf: "verlauf",
  ertrag_verlauf: "verlauf",
  // Einkaufspreise sind ein eigener Menuepunkt -> eigener Feature-Key.
  // Steuerfaktor der Gebühren: gehört zur Ertragsrechnung, hängt am EK-Bereich.
  ust_faktor: "ek",
  ust_faktor_setzen: "ek",
  steuerprofil_setzen: "ek",
  asin_ek: "ek",
  ek_setzen: "ek",
  ek_loeschen: "ek",
  ek_import_csv: "ek",
  ek_import_url: "ek",
  ek_url_speichern: "ek",
  einstellungen: "verlauf",
  einstellungen_setzen: "verlauf",
  get_sales_overview: "sales",
  get_orders_overview: "orders",
  get_listings_overview: "listings",
  get_ads_overview: "ads",
  // Derselbe Tab bzw. dieselben Zahlen, andere Quelle (ads_daily statt
  // report_data) — muessen hinter demselben Feature liegen, sonst umginge der
  // Zeitraum-Weg die Sperre. `ads_verlauf` ist der Web-, `get_ads_verlauf` der
  // KI-Name derselben Sache.
  ads_verlauf: "ads",
  get_ads_verlauf: "ads",
  // Struktur, Suchbegriffe und Platzierungen: dieselbe Quelle, dasselbe Feature.
  ads_struktur: "ads",
  get_ads_struktur: "ads",
  ads_suchbegriffe: "ads",
  get_ads_suchbegriffe: "ads",
  ads_platzierungen: "ads",
  get_ads_platzierungen: "ads",
  ads_ziele: "ads",
  get_ads_ziele: "ads",
  get_returns_overview: "returns",
  returns_uebersicht: "returns",
  get_product_performance: "products",
  produkt_uebersicht: "products",
  // Einstellung je Produkt — gehoert zum Produkt-Feature, nicht zu Ads, auch
  // wenn die Tabelle im Ads-Tab steht.
  asin_einstellung_setzen: "products",
  sqp: "sqp",
  sqp_asins: "sqp",
  sqp_laden: "sqp",
  reimbursements_radar: "erstattungen",
  stockout_radar: "nachschub",
  ladenhueter_radar: "ladenhueter",
  bestandshistorie: "bestandshistorie",
  board_report: "board",
  // Fee Decoder: Modul 2 (Größenklassen-Korridor) und Modul 3 (Soll-Ist-Maße).
  groessenklassen: "gebuehren",
  gebuehren_vorschau: "gebuehren",
  masse_abgleich: "masse",
  steuerbarkeit: "gebuehren",
  lager_kosten: "lager",
  // Eigenes Feature, nicht an "lager" gehaengt: sonst haette der Bereich keine
  // eigene Zeile in der Tarif-Matrix und liesse sich nicht getrennt schalten.
  betriebskosten: "betriebskosten",
  masse_uebersicht: "masse",
  abrechnungen: "auszahlungen",
  // MCP-Zugang (KI-Anbindung) — schaltbar, damit das Häkchen in der Tarif-Matrix
  // auch wirklich greift und nicht nur den Tab versteckt.
  mcp_tokens: "mcp",
  mcp_token_erzeugen: "mcp",
  mcp_token_widerrufen: "mcp",
  // Strategie-Pfad (Rolle → Korridor → Befund → Maßnahme) inkl. Wizard-Schritte.
  strategien: "strategie",
  strategie_historie: "strategie",
  strategie_uebersicht: "strategie",
  wizard_rollen: "strategie",
  wizard_produkte: "strategie",
  wizard_asin: "strategie",
  wizard_befund: "strategie",
  wizard_massnahmen: "strategie",
  wizard_wiedervorlage: "strategie",
  strategie_bestaetigen: "strategie",
  strategie_review: "strategie",
  strategie_vorschlag_verwerfen: "strategie",
  strategie_lauf: "strategie",
  wizard_korridor_setzen: "strategie",
  wizard_korridor_zuruecksetzen: "strategie",
  befund_erzeugen: "strategie",
  massnahme_erstellen: "strategie",
  massnahme_status: "strategie",
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
  fr_manuelle_aenderung: "aenderungen",
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

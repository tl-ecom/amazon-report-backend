// flightrecorder.ts — Lese-/Schreibzugriffe für den Flight Recorder (Change-Event-
// Inbox, ASIN-Timeline, Kontext-Erfassung). DB-Modul wie verlauf.ts; die einzige
// reine, testbare Logik (naechsterStatus) ist ausgelagert.
//
// Trennung Fakt/Interpretation bleibt gewahrt: change_events wird NICHT verändert
// außer im status (bearbeitet/ignoriert); die Interpretation landet ausschließlich
// in change_event_context.

export type Klassifikation =
  | "geplanter_test"
  | "operative_anpassung"
  | "extern"
  | "unbeabsichtigt"
  | "nicht_relevant"
  | "spaeter";

/** Reine Statusabbildung nach Nutzer-Klassifikation (unit-getestet). */
export function naechsterStatus(klass: Klassifikation): { status: string; requires_context: boolean } {
  if (klass === "nicht_relevant") return { status: "ignoriert", requires_context: false };
  if (klass === "spaeter") return { status: "kontext_erforderlich", requires_context: true };
  return { status: "bestaetigt", requires_context: false };
}

// --- Reads ---

/** Change-Event-Inbox. Default: nur die, die noch Kontext brauchen. */
export async function changeEvents(
  supabase: any,
  tenant_id: string,
  args: { status?: string; asin?: string; nur_offen?: boolean; limit?: number } = {},
): Promise<unknown> {
  let q = supabase
    .from("change_events")
    .select("id, asin, seller_sku, event_type, event_category, previous_value, new_value, relevance, status, requires_context, effective_at, detected_at, change_event_context(*)")
    .eq("tenant_id", tenant_id)
    .order("detected_at", { ascending: false })
    .limit(Math.min(Number(args.limit ?? 100), 500));

  if (args.asin) q = q.eq("asin", args.asin);
  if (args.status) q = q.eq("status", args.status);
  else if (args.nur_offen !== false) q = q.eq("requires_context", true).eq("status", "kontext_erforderlich");

  const { data, error } = await q;
  if (error) throw new Error(`change_events: ${error.message}`);
  return { events: data ?? [] };
}

/** Timeline einer ASIN: Snapshot-Verlauf (Preis/Bestand/Status je SKU/Tag) + Events. */
export async function asinTimeline(supabase: any, tenant_id: string, args: { asin?: string; tage?: number } = {}): Promise<unknown> {
  const asin = String(args.asin ?? "").trim();
  if (!asin) throw new Error("asin fehlt");
  const tage = Math.min(Number(args.tage ?? 120), 400);
  const abDate = new Date();
  abDate.setDate(abDate.getDate() - tage);
  const ab = abDate.toISOString().slice(0, 10);

  const [info, snaps, events] = await Promise.all([
    supabase.from("asins").select("asin, produktname, marketplace_id, erstmals_gesehen").eq("tenant_id", tenant_id).eq("asin", asin).maybeSingle(),
    supabase.from("asin_snapshots").select("seller_sku, snapshot_date, price, quantity, status, is_fba").eq("tenant_id", tenant_id).eq("asin", asin).gte("snapshot_date", ab).order("snapshot_date", { ascending: true }),
    supabase.from("change_events").select("id, seller_sku, event_type, event_category, previous_value, new_value, relevance, status, effective_at, change_event_context(*)").eq("tenant_id", tenant_id).eq("asin", asin).order("detected_at", { ascending: false }),
  ]);
  if (snaps.error) throw new Error(`asin_snapshots: ${snaps.error.message}`);
  if (events.error) throw new Error(`change_events: ${events.error.message}`);

  return {
    asin,
    info: info.data ?? null,
    snapshots: snaps.data ?? [],
    events: events.data ?? [],
  };
}

// --- Write ---

/**
 * Bestätigt ein Change Event und legt/aktualisiert den Nutzerkontext.
 * Verifiziert zuerst, dass das Event DIESEM Tenant gehört (service_role umgeht RLS).
 */
export async function setzeKontext(
  supabase: any,
  tenant_id: string,
  user_id: string,
  args: {
    change_event_id?: string;
    classification?: Klassifikation;
    is_planned_test?: boolean;
    hypothesis?: string;
    target_metric?: string;
    target_value?: string;
    reason?: string;
    external_factor?: string;
    note?: string;
  },
): Promise<unknown> {
  const eventId = String(args.change_event_id ?? "").trim();
  const klass = args.classification;
  if (!eventId) throw new Error("change_event_id fehlt");
  if (!klass) throw new Error("classification fehlt");

  // Eigentümerschaft prüfen — NIE aus dem Body vertrauen.
  const { data: ev, error: evErr } = await supabase
    .from("change_events").select("id").eq("id", eventId).eq("tenant_id", tenant_id).maybeSingle();
  if (evErr) throw new Error(`Lookup: ${evErr.message}`);
  if (!ev) throw new Error("Change Event nicht gefunden (oder nicht dieser Tenant).");

  const now = new Date().toISOString();
  const { error: ctxErr } = await supabase.from("change_event_context").upsert({
    change_event_id: eventId,
    classification: klass,
    is_planned_test: args.is_planned_test ?? (klass === "geplanter_test"),
    hypothesis: args.hypothesis ?? null,
    target_metric: args.target_metric ?? null,
    target_value: args.target_value ?? null,
    reason: args.reason ?? null,
    external_factor: args.external_factor ?? null,
    note: args.note ?? null,
    responsible_user_id: user_id,
    confirmed_by: user_id,
    confirmed_at: now,
  }, { onConflict: "change_event_id" });
  if (ctxErr) throw new Error(`Kontext: ${ctxErr.message}`);

  const { status, requires_context } = naechsterStatus(klass);
  const { error: updErr } = await supabase
    .from("change_events")
    .update({ status, requires_context, updated_at: now })
    .eq("id", eventId).eq("tenant_id", tenant_id);
  if (updErr) throw new Error(`Status-Update: ${updErr.message}`);

  return { ok: true, change_event_id: eventId, status };
}

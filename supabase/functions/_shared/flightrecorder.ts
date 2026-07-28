// flightrecorder.ts — Lese-/Schreibzugriffe für den Flight Recorder (Change-Event-
// Inbox, ASIN-Timeline, Kontext-Erfassung). DB-Modul wie verlauf.ts; die einzige
// reine, testbare Logik (naechsterStatus) ist ausgelagert.
//
// Trennung Fakt/Interpretation bleibt gewahrt: change_events wird NICHT verändert
// außer im status (bearbeitet/ignoriert); die Interpretation landet ausschließlich
// in change_event_context.

import { erstelleExperiment } from "./experiments.ts";

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

/**
 * Change-Event-Log. Zwei Modi über die Args:
 *   * Inbox (Default): nur Events, die noch Kontext brauchen (nur_offen).
 *   * Voller Log (alle:true): alle Änderungen, filterbar nach Produkt (asin),
 *     Typ (event_type), Quelle (quelle: auto|manuell) und Zeitraum (von/bis).
 */
export async function changeEvents(
  supabase: any,
  tenant_id: string,
  args: {
    status?: string; asin?: string; nur_offen?: boolean; alle?: boolean;
    quelle?: string; event_type?: string; von?: string; bis?: string; limit?: number;
  } = {},
): Promise<unknown> {
  let q = supabase
    .from("change_events")
    .select("id, asin, seller_sku, event_type, event_category, previous_value, new_value, relevance, status, requires_context, source, detected_automatically, note, effective_at, detected_at, change_event_context(*)")
    .eq("tenant_id", tenant_id)
    .order("effective_at", { ascending: false, nullsFirst: false })
    .order("detected_at", { ascending: false })
    .limit(Math.min(Number(args.limit ?? 300), 1000));

  if (args.asin) q = q.eq("asin", args.asin);
  if (args.event_type) q = q.eq("event_type", args.event_type);
  if (args.quelle === "manuell") q = q.eq("detected_automatically", false);
  else if (args.quelle === "auto") q = q.eq("detected_automatically", true);
  if (args.von) q = q.gte("effective_at", String(args.von).slice(0, 10));
  if (args.bis) q = q.lte("effective_at", String(args.bis).slice(0, 10));

  if (args.status) q = q.eq("status", args.status);
  else if (!args.alle && args.nur_offen !== false) {
    q = q.eq("requires_context", true).eq("status", "kontext_erforderlich");
  }

  const { data, error } = await q;
  if (error) throw new Error(`change_events: ${error.message}`);
  return { events: data ?? [] };
}

/** Produktliste (ASIN + Name) für Filter-Dropdown und das manuelle Erfassen. */
export async function frProdukte(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase
    .from("asins")
    .select("asin, produktname")
    .eq("tenant_id", tenant_id)
    .order("produktname", { ascending: true });
  if (error) throw new Error(`asins: ${error.message}`);
  return { produkte: data ?? [] };
}

// --- Manuelle Änderungen (was die Snapshot-Diff-Engine NICHT sieht) ---

/** Erlaubte manuelle Änderungstypen. Alles andere wird abgelehnt. */
export const MANUELLE_TYPEN: Record<string, string> = {
  bild_geaendert: "Bilder geändert",
  titel_geaendert: "Titel geändert",
  bullets_geaendert: "Bulletpoints geändert",
  aplus_geaendert: "A+ Content geändert",
  bewertung_schnitt: "Bewertung Ø geändert",
  bewertung_anzahl: "Bewertungsanzahl geändert",
  video_geaendert: "Video geändert",
  varianten_geaendert: "Varianten geändert",
  kategorie_geaendert: "Kategorie geändert",
  sonstiges: "Sonstige Änderung",
};
const ERLAUBTE_RELEVANZ = new Set(["kritisch", "hoch", "mittel", "niedrig", "informativ"]);

/**
 * Baut die einzufügende Zeile aus den Nutzer-Eingaben (rein & testbar). uuid und
 * heute werden hereingereicht, damit die Funktion deterministisch bleibt.
 * Gibt { fehler } zurück, wenn Typ ungültig ist.
 */
export function baueManuelleAenderung(
  tenant_id: string,
  args: any,
  uuid: string,
  heute: string,
): { row?: Record<string, unknown>; fehler?: string } {
  const event_type = String(args?.event_type ?? "").trim();
  if (!MANUELLE_TYPEN[event_type]) return { fehler: "Unbekannter Änderungstyp." };

  const eff = String(args?.effective_at ?? "").slice(0, 10);
  const effective_at = /^\d{4}-\d{2}-\d{2}$/.test(eff) ? eff : heute;
  const relevance = ERLAUBTE_RELEVANZ.has(String(args?.relevance)) ? String(args.relevance) : "informativ";

  return {
    row: {
      tenant_id,
      asin: String(args?.asin ?? "").trim() || null,
      seller_sku: String(args?.seller_sku ?? "").trim() || null,
      event_type,
      event_category: "manuell",
      source: "manuell",
      detected_automatically: false,
      detection_rule: "manuell",
      effective_at,
      previous_value: String(args?.previous_value ?? "").trim() || null,
      new_value: String(args?.new_value ?? "").trim() || null,
      note: String(args?.note ?? "").trim() || null,
      relevance,
      status: "bestaetigt", // manuell erfasst = bewusst dokumentiert, kein Kontext nötig
      requires_context: false,
      duplicate_key: `manuell|${uuid}`,
    },
  };
}

/**
 * Trägt eine manuelle Änderung ein. ASIN — falls angegeben — muss diesem Tenant
 * gehören (NIE aus dem Body vertrauen). Coach UND Coachee dürfen erfassen.
 */
export async function erfasseManuelleAenderung(
  supabase: any,
  tenant_id: string,
  _user_id: string,
  args: any,
): Promise<unknown> {
  const { row, fehler } = baueManuelleAenderung(
    tenant_id, args, crypto.randomUUID(), new Date().toISOString().slice(0, 10),
  );
  if (fehler || !row) throw new Error(fehler ?? "Ungültige Eingabe.");

  if (row.asin) {
    const { data: a, error: aErr } = await supabase
      .from("asins").select("asin").eq("tenant_id", tenant_id).eq("asin", row.asin).maybeSingle();
    if (aErr) throw new Error(`ASIN-Prüfung: ${aErr.message}`);
    if (!a) throw new Error("ASIN gehört nicht zu dieser Firma.");
  }

  const { data, error } = await supabase.from("change_events").insert(row).select("id").maybeSingle();
  if (error) throw new Error(`manuelle Änderung: ${error.message}`);
  return { ok: true, id: data?.id ?? null };
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
    .from("change_events").select("id, asin, seller_sku, effective_at").eq("id", eventId).eq("tenant_id", tenant_id).maybeSingle();
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

  // Geplanter Test → automatisch ein Experiment anlegen (idempotent je Event).
  let experiment_erstellt = false;
  if (klass === "geplanter_test") {
    await erstelleExperiment(supabase, tenant_id, ev, {
      hypothesis: args.hypothesis,
      target_metric: args.target_metric,
      target_value: args.target_value,
      user_id,
    });
    experiment_erstellt = true;
  }

  return { ok: true, change_event_id: eventId, status, experiment_erstellt };
}

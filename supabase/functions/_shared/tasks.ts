// tasks.ts — Action Board (§10/§15): Aufgaben lesen, anlegen, aus einer Diagnose
// ableiten und den Status setzen. Alles strikt tenant-gescoped (die api reicht die
// effektive Firma durch — funktioniert also auch in der Coach-Ansicht).

const PRIO = new Set(["kritisch", "hoch", "mittel", "niedrig"]);
const STATUS = new Set(["offen", "in_arbeit", "erledigt", "verworfen"]);
const STATUS_RANG: Record<string, number> = { offen: 0, in_arbeit: 1, erledigt: 2, verworfen: 3 };
const PRIO_RANG: Record<string, number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 };

const DIAG_TYP_LABEL: Record<string, string> = {
  traffic_ohne_verkauf: "Traffic ohne Verkauf prüfen",
  conversion_unter_schnitt: "Conversion verbessern",
  gute_cvr_wenig_traffic: "Reichweite erhöhen",
  umsatzkonzentration: "Umsatzrisiko streuen",
  hohe_retourenquote: "Retouren senken",
  fbm_ohne_bestand: "Bestand auffüllen / Angebot deaktivieren",
};

interface TaskEingabe {
  titel?: string;
  beschreibung?: string;
  prioritaet?: string;
  asin?: string;
  faellig_am?: string;
  quelle?: string;
  diagnose_id?: string;
}

/** Aufgaben lesen — aktive zuerst (offen/in_arbeit), dann nach Priorität. */
export async function listeTasks(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("tasks")
    .select("id, titel, beschreibung, prioritaet, status, quelle, diagnose_id, asin, faellig_am, created_at, updated_at, erledigt_am")
    .eq("tenant_id", tenant_id);
  if (error) throw new Error(`tasks read: ${error.message}`);

  const rows = (data ?? []).slice().sort((a: any, b: any) => {
    const s = (STATUS_RANG[a.status] ?? 9) - (STATUS_RANG[b.status] ?? 9);
    if (s !== 0) return s;
    return (PRIO_RANG[a.prioritaet] ?? 9) - (PRIO_RANG[b.prioritaet] ?? 9);
  });
  const offen = rows.filter((r: any) => r.status === "offen" || r.status === "in_arbeit").length;
  return { tasks: rows, offen };
}

/** Aufgabe anlegen (manuell oder mit Diagnose-Bezug). */
export async function erstelleTask(
  supabase: any, tenant_id: string, userId: string, e: TaskEingabe,
): Promise<unknown> {
  const titel = (e.titel ?? "").trim();
  if (!titel) throw new Error("Titel fehlt");
  const prioritaet = e.prioritaet && PRIO.has(e.prioritaet) ? e.prioritaet : "mittel";
  const quelle = e.quelle === "diagnose" ? "diagnose" : "manuell";

  const { data, error } = await supabase.from("tasks").insert({
    tenant_id, titel,
    beschreibung: e.beschreibung?.trim() || null,
    prioritaet, quelle,
    diagnose_id: e.diagnose_id ?? null,
    asin: e.asin?.trim() || null,
    faellig_am: e.faellig_am || null,
    erstellt_von: userId,
  }).select().single();
  if (error) throw new Error(`task insert: ${error.message}`);
  return { task: data };
}

/** Aus einer Diagnose eine Aufgabe machen — idempotent (eine aktive je Diagnose). */
export async function taskAusDiagnose(
  supabase: any, tenant_id: string, userId: string, diagnose_id: string,
): Promise<unknown> {
  if (!diagnose_id) throw new Error("diagnose_id fehlt");

  // Schon eine offene/laufende Aufgabe zu dieser Diagnose? Dann diese zurückgeben.
  const { data: vorhanden } = await supabase.from("tasks")
    .select("id, titel, status").eq("tenant_id", tenant_id).eq("diagnose_id", diagnose_id)
    .in("status", ["offen", "in_arbeit"]).maybeSingle();
  if (vorhanden) return { task: vorhanden, bereits_vorhanden: true };

  const { data: d, error: dErr } = await supabase.from("diagnoses")
    .select("typ, asin, beobachtung, begruendung, prioritaet")
    .eq("tenant_id", tenant_id).eq("id", diagnose_id).maybeSingle();
  if (dErr) throw new Error(`diagnose read: ${dErr.message}`);
  if (!d) throw new Error("Diagnose nicht gefunden");

  const titel = `${DIAG_TYP_LABEL[d.typ] ?? d.typ}${d.asin ? ` — ${d.asin}` : ""}`;
  const beschreibung = `${d.beobachtung}\n\n${d.begruendung}`;

  return await erstelleTask(supabase, tenant_id, userId, {
    titel, beschreibung, prioritaet: d.prioritaet, asin: d.asin ?? undefined,
    quelle: "diagnose", diagnose_id,
  });
}

/** Status setzen. 'erledigt' stempelt erledigt_am, ein Reopen löscht ihn wieder. */
export async function setzeTaskStatus(
  supabase: any, tenant_id: string, id: string, status: string,
): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt");
  if (!STATUS.has(status)) throw new Error(`ungültiger Status: ${status}`);
  const { error } = await supabase.from("tasks").update({
    status,
    updated_at: new Date().toISOString(),
    erledigt_am: status === "erledigt" ? new Date().toISOString() : null,
  }).eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`task status: ${error.message}`);
  return { ok: true };
}

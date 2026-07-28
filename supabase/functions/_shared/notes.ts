// notes.ts — Coaching Notes (§17). Notizen des Coaches pro Coachee-Firma.
//   sichtbarkeit 'intern'  -> nur Coach/Admin
//   sichtbarkeit 'coachee' -> Teilnehmer sieht sie als Coach-Feedback
// Schreiben darf NUR der Coach/Admin (in der api geprüft). Der Coachee liest nur
// die für ihn freigegebenen — hier über den isAdmin-Filter erzwungen.

const SICHTBARKEIT = new Set(["intern", "coachee"]);

/** Notizen lesen. Coach/Admin: alle. Coachee: nur sichtbarkeit='coachee'. */
export async function listeNotes(supabase: any, tenant_id: string, isAdmin: boolean): Promise<unknown> {
  let q = supabase.from("coaching_notes")
    .select("id, asin, text, sichtbarkeit, erstellt_von, created_at, updated_at")
    .eq("tenant_id", tenant_id);
  if (!isAdmin) q = q.eq("sichtbarkeit", "coachee");
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw new Error(`coaching_notes read: ${error.message}`);
  return { notes: data ?? [], als_coach: isAdmin };
}

interface NoteEingabe { text?: string; asin?: string; sichtbarkeit?: string }

/** Notiz anlegen (nur Coach/Admin — in der api abgesichert). */
export async function erstelleNote(
  supabase: any, tenant_id: string, userId: string, e: NoteEingabe,
): Promise<unknown> {
  const text = (e.text ?? "").trim();
  if (!text) throw new Error("Text fehlt");
  const sichtbarkeit = e.sichtbarkeit && SICHTBARKEIT.has(e.sichtbarkeit) ? e.sichtbarkeit : "intern";
  const { data, error } = await supabase.from("coaching_notes").insert({
    tenant_id, text, asin: e.asin?.trim() || null, sichtbarkeit, erstellt_von: userId,
  }).select().single();
  if (error) throw new Error(`coaching_notes insert: ${error.message}`);
  return { note: data };
}

/** Sichtbarkeit umschalten (intern <-> coachee). Nur Coach/Admin. */
export async function setzeNoteSichtbarkeit(
  supabase: any, tenant_id: string, id: string, sichtbarkeit: string,
): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt");
  if (!SICHTBARKEIT.has(sichtbarkeit)) throw new Error(`ungültige Sichtbarkeit: ${sichtbarkeit}`);
  const { error } = await supabase.from("coaching_notes")
    .update({ sichtbarkeit, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`coaching_notes sichtbarkeit: ${error.message}`);
  return { ok: true };
}

/** Notiz löschen. Nur Coach/Admin. */
export async function loescheNote(supabase: any, tenant_id: string, id: string): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt");
  const { error } = await supabase.from("coaching_notes").delete().eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`coaching_notes delete: ${error.message}`);
  return { ok: true };
}

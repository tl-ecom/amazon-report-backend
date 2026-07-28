// strategie_flow.ts — Bestätigungs-Flow für den Strategie-Layer (Schritt 3).
// DB-Modul wie flightrecorder.ts/notes.ts: die reinen, testbaren Helfer
// (berechneReviewFaellig, baueZuordnungRow) sind ausgelagert, alles andere fasst
// die DB an. Reine Rule-Engine (strategie.ts) bleibt DB-frei.
//
// Kernregeln aus dem Auftrag:
//   * Genau EINE aktive Zuordnung je ASIN (Partial-Unique-Index in der DB).
//   * Historie ist Pflicht: nichts wird überschrieben — die alte aktive Zeile wird
//     mit gueltig_bis geschlossen, eine neue eingefügt.
//   * Ein Vorschlag wird NIE ohne Bestätigung aktiv; Bestätigen/Überschreiben
//     schreibt confirmed_at/by, Annehmen erbt Begründung/Confidence/Basis.

// --- reine Helfer (unit-getestet) ---

/** Review-Fälligkeit: expliziter Override gewinnt, sonst heute + max_dauer_tage der
 *  Rolle. Ohne Frist (max_dauer_tage null) und ohne Override → null. */
export function berechneReviewFaellig(
  heute: string,
  maxDauerTage: number | null,
  override?: string | null,
): string | null {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  if (maxDauerTage == null || maxDauerTage <= 0) return null;
  const d = new Date(heute + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + maxDauerTage);
  return d.toISOString().slice(0, 10);
}

/** Baut die neue (aktive) Zuordnungszeile. Bei Annahme eines Vorschlags werden
 *  Begründung/Confidence/Basis übernommen; bei manuellem Überschreiben null. */
export function baueZuordnungRow(p: {
  tenant_id: string;
  asin: string;
  rolle: string;
  quelle: "suggested" | "confirmed";
  user_id: string;
  now: string;
  review: string | null;
  vorschlag?: { konfidenz?: string | null; begruendung?: string | null; basis?: unknown } | null;
  notiz?: string | null;
}): Record<string, unknown> {
  return {
    tenant_id: p.tenant_id,
    asin: p.asin,
    rolle: p.rolle,
    quelle: p.quelle,
    gueltig_ab: p.now,
    gueltig_bis: null, // aktiv
    bestaetigt_am: p.now,
    bestaetigt_von: p.user_id,
    review_faellig: p.review,
    konfidenz: p.vorschlag?.konfidenz ?? null,
    begruendung: p.vorschlag?.begruendung ?? null,
    basis: p.vorschlag?.basis ?? null,
    notiz: p.notiz ?? null,
  };
}

// --- Reads ---

/** Aktuelle aktive Zuordnung je ASIN + offene Vorschläge + Definitionen (für die UI). */
export async function listeStrategien(supabase: any, tenant_id: string): Promise<unknown> {
  const [zuord, vors, defs] = await Promise.all([
    supabase.from("asin_strategien").select("*").eq("tenant_id", tenant_id).is("gueltig_bis", null).order("asin", { ascending: true }),
    supabase.from("strategie_vorschlaege").select("*").eq("tenant_id", tenant_id).eq("status", "offen").order("asin", { ascending: true }),
    supabase.from("strategie_definitionen").select("*").eq("aktiv", true).order("rolle", { ascending: true }),
  ]);
  if (zuord.error) throw new Error(`asin_strategien: ${zuord.error.message}`);
  if (vors.error) throw new Error(`strategie_vorschlaege: ${vors.error.message}`);
  if (defs.error) throw new Error(`strategie_definitionen: ${defs.error.message}`);
  return { zuordnungen: zuord.data ?? [], vorschlaege: vors.data ?? [], definitionen: defs.data ?? [] };
}

/** Historie einer ASIN (alle Zuordnungen, neueste zuerst). */
export async function strategieHistorie(supabase: any, tenant_id: string, args: { asin?: string } = {}): Promise<unknown> {
  const asin = String(args.asin ?? "").trim();
  if (!asin) throw new Error("asin fehlt");
  const { data, error } = await supabase
    .from("asin_strategien").select("*")
    .eq("tenant_id", tenant_id).eq("asin", asin)
    .order("gueltig_ab", { ascending: false });
  if (error) throw new Error(`asin_strategien: ${error.message}`);
  return { asin, historie: data ?? [] };
}

// --- Writes ---

/**
 * Bestätigt eine Rolle für eine ASIN — als Annahme eines Vorschlags (quelle
 * 'suggested', vorschlag_id gesetzt) ODER als manuelles Überschreiben (quelle
 * 'confirmed'). Schließt die bisherige aktive Zeile und legt eine neue an
 * (nichts wird überschrieben). Verifiziert Tenant-Eigentum von ASIN & Rolle.
 */
export async function bestaetigeStrategie(
  supabase: any,
  tenant_id: string,
  user_id: string,
  args: any,
): Promise<unknown> {
  const asin = String(args?.asin ?? "").trim();
  const rolle = String(args?.rolle ?? "").trim();
  const quelle: "suggested" | "confirmed" = args?.quelle === "suggested" ? "suggested" : "confirmed";
  if (!asin) throw new Error("asin fehlt");
  if (!rolle) throw new Error("rolle fehlt");

  // ASIN gehört diesem Tenant? (NIE aus dem Body vertrauen)
  const { data: a, error: aErr } = await supabase.from("asins").select("asin").eq("tenant_id", tenant_id).eq("asin", asin).maybeSingle();
  if (aErr) throw new Error(`ASIN-Prüfung: ${aErr.message}`);
  if (!a) throw new Error("ASIN gehört nicht zu dieser Firma.");

  // Rolle existiert? + Frist holen
  const { data: def, error: dErr } = await supabase.from("strategie_definitionen").select("rolle, max_dauer_tage").eq("rolle", rolle).maybeSingle();
  if (dErr) throw new Error(`Rollen-Prüfung: ${dErr.message}`);
  if (!def) throw new Error("Unbekannte Rolle.");

  // Optionalen Vorschlag laden (für Begründung/Confidence/Basis + Statuswechsel).
  let vorschlag: any = null;
  const vorschlagId = String(args?.vorschlag_id ?? "").trim();
  if (vorschlagId) {
    const { data: v, error: vErr } = await supabase.from("strategie_vorschlaege").select("*").eq("id", vorschlagId).eq("tenant_id", tenant_id).maybeSingle();
    if (vErr) throw new Error(`Vorschlag-Lookup: ${vErr.message}`);
    if (!v) throw new Error("Vorschlag nicht gefunden.");
    vorschlag = v;
  }

  const now = new Date().toISOString();
  const heute = now.slice(0, 10);
  const review = berechneReviewFaellig(heute, def.max_dauer_tage, args?.review_faellig);

  // 1) bisherige aktive Zeile schließen (nicht überschreiben).
  const { error: closeErr } = await supabase.from("asin_strategien")
    .update({ gueltig_bis: now })
    .eq("tenant_id", tenant_id).eq("asin", asin).is("gueltig_bis", null);
  if (closeErr) throw new Error(`Schließen: ${closeErr.message}`);

  // 2) neue aktive Zeile.
  const row = baueZuordnungRow({ tenant_id, asin, rolle, quelle, user_id, now, review, vorschlag, notiz: args?.notiz });
  const { data: neu, error: insErr } = await supabase.from("asin_strategien").insert(row).select("*").maybeSingle();
  if (insErr) throw new Error(`Einfügen: ${insErr.message}`);

  // 3) Vorschlag-Status nachziehen.
  if (vorschlag) {
    await supabase.from("strategie_vorschlaege")
      .update({ status: "angenommen", entschieden_am: now, entschieden_von: user_id })
      .eq("id", vorschlag.id).eq("tenant_id", tenant_id);
  } else {
    // Manuelles Überschreiben: einen etwaigen offenen Vorschlag für die ASIN entwerten.
    await supabase.from("strategie_vorschlaege")
      .update({ status: "ersetzt", entschieden_am: now, entschieden_von: user_id })
      .eq("tenant_id", tenant_id).eq("asin", asin).eq("status", "offen");
  }

  return { ok: true, zuordnung: neu };
}

/** Nur das Review-Datum der aktiven Zuordnung setzen (kein Rollenwechsel). */
export async function setzeReview(supabase: any, tenant_id: string, _user_id: string, args: any): Promise<unknown> {
  const asin = String(args?.asin ?? "").trim();
  const review = String(args?.review_faellig ?? "").slice(0, 10);
  if (!asin) throw new Error("asin fehlt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(review)) throw new Error("review_faellig (YYYY-MM-DD) fehlt/ungültig.");
  const { data, error } = await supabase.from("asin_strategien")
    .update({ review_faellig: review })
    .eq("tenant_id", tenant_id).eq("asin", asin).is("gueltig_bis", null)
    .select("id").maybeSingle();
  if (error) throw new Error(`Review: ${error.message}`);
  if (!data) throw new Error("Keine aktive Strategie für diese ASIN.");
  return { ok: true };
}

/** Einen offenen Vorschlag ablehnen. */
export async function verwerfeVorschlag(supabase: any, tenant_id: string, user_id: string, args: any): Promise<unknown> {
  const id = String(args?.vorschlag_id ?? args?.id ?? "").trim();
  if (!id) throw new Error("vorschlag_id fehlt");
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("strategie_vorschlaege")
    .update({ status: "abgelehnt", entschieden_am: now, entschieden_von: user_id })
    .eq("id", id).eq("tenant_id", tenant_id).eq("status", "offen")
    .select("id").maybeSingle();
  if (error) throw new Error(`Vorschlag: ${error.message}`);
  if (!data) throw new Error("Offener Vorschlag nicht gefunden.");
  return { ok: true };
}

// massnahmen_lauf.ts — DB-Schicht für Schritt 4. Reine Logik (Vorschläge,
// Validierung, Statuswechsel, Summen) liegt in massnahmen.ts.
//
// Enthält schon die Datenbasis für die WIEDERVORLAGE: offene Maßnahmen + was
// seit dem letzten Durchlauf erledigt/verworfen wurde, inkl. erwartetem Effekt.

import {
  MAX_OFFENE, pruefeMassnahme, pruefeStatusWechsel, schlageMassnahmenVor, summeEffekt,
} from "./massnahmen.ts";

/** Maßnahmen einer ASIN + Vorschläge aus dem letzten Befund. */
export async function listeMassnahmen(supabase: any, tenant_id: string, asin: string): Promise<unknown> {
  if (!asin) return { massnahmen: [], vorschlaege: [], offen: 0, max_offene: MAX_OFFENE };

  const [mRes, bRes] = await Promise.all([
    supabase.from("strategie_massnahme")
      .select("id, asin, befund_id, kennzahl, text, effekt_eur, status, grund, erledigt_am, erstellt_am")
      .eq("tenant_id", tenant_id).eq("asin", asin)
      .order("erstellt_am", { ascending: false }),
    supabase.from("strategie_befund").select("id, fakten, erstellt_am")
      .eq("tenant_id", tenant_id).eq("asin", asin)
      .order("erstellt_am", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const massnahmen = (mRes.data ?? []) as any[];
  const offene = massnahmen.filter((m) => m.status === "offen");

  // Vorschläge aus dem letzten Befund, ohne bereits übernommene Kennzahlen.
  const schonDa = new Set(offene.map((m) => String(m.kennzahl ?? "")));
  const vorschlaege = schlageMassnahmenVor(bRes.data?.fakten ?? {})
    .filter((v) => !schonDa.has(v.kennzahl))
    .slice(0, Math.max(0, MAX_OFFENE - offene.length));

  return {
    massnahmen,
    vorschlaege,
    befund_id: bRes.data?.id ?? null,
    offen: offene.length,
    max_offene: MAX_OFFENE,
    erwarteter_effekt_offen: summeEffekt(offene),
  };
}

/** Maßnahme anlegen (aus Vorschlag übernommen oder manuell). */
export async function erstelleMassnahme(supabase: any, tenant_id: string, user_id: string, args: any): Promise<unknown> {
  const asin = String(args?.asin ?? "").trim();
  if (!asin) throw new Error("asin fehlt");

  const { count, error: cErr } = await supabase.from("strategie_massnahme")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenant_id).eq("asin", asin).eq("status", "offen");
  if (cErr) throw new Error(`Zählen: ${cErr.message}`);

  const { text, effekt_eur } = pruefeMassnahme(args, count ?? 0);

  const { data, error } = await supabase.from("strategie_massnahme").insert({
    tenant_id, asin,
    befund_id: args?.befund_id ?? null,
    kennzahl: args?.kennzahl ? String(args.kennzahl) : null,
    text, effekt_eur, status: "offen", erstellt_von: user_id,
  }).select("*").maybeSingle();
  if (error) throw new Error(`Maßnahme anlegen: ${error.message}`);
  return { ok: true, massnahme: data };
}

/** Status setzen: erledigt / verworfen (mit Grund) / wieder öffnen. */
export async function setzeMassnahmeStatus(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const id = String(args?.id ?? "").trim();
  if (!id) throw new Error("id fehlt");
  const w = pruefeStatusWechsel(args?.status, args?.grund, new Date().toISOString());

  // Beim Wiedereröffnen die 3er-Grenze erneut prüfen.
  if (w.status === "offen") {
    const { data: alt } = await supabase.from("strategie_massnahme").select("asin, status").eq("id", id).eq("tenant_id", tenant_id).maybeSingle();
    if (!alt) throw new Error("Maßnahme nicht gefunden.");
    if (alt.status !== "offen") {
      const { count } = await supabase.from("strategie_massnahme")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant_id).eq("asin", alt.asin).eq("status", "offen");
      if ((count ?? 0) >= MAX_OFFENE) {
        throw new Error(`Maximal ${MAX_OFFENE} offene Maßnahmen je Produkt.`);
      }
    }
  }

  const { error } = await supabase.from("strategie_massnahme")
    .update({ status: w.status, grund: w.grund, erledigt_am: w.erledigt_am })
    .eq("id", id).eq("tenant_id", tenant_id);
  if (error) throw new Error(`Status: ${error.message}`);
  return { ok: true };
}

// Die Wiedervorlage mit Ist-Abgleich liegt in wiedervorlage_lauf.ts (loopDaten).

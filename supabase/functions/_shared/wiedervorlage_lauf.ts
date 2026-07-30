// wiedervorlage_lauf.ts — DB-Schicht des Loops. Reine Mess-/Verdichtungslogik
// liegt in wiedervorlage.ts (unit-getestet).
//
// Für jede ERLEDIGTE Maßnahme wird der ASIN-Umsatz im Fenster VOR und NACH dem
// Erledigen verglichen (Europe/Berlin, ohne Stornos) und auf 30 Tage normalisiert.
// Ergebnis: erwartet vs. tatsächlich — die Zeile, an der Pulse sich messen lässt.

import {
  fasseLoopZusammen, FENSTER_TAGE, type Messung, messeEffekt, tageZwischen, tagPlus,
} from "./wiedervorlage.ts";

async function fensterUmsatz(
  supabase: any, tenant_id: string, asin: string, von: string, bis: string,
): Promise<{ umsatz: number | null; tage: number }> {
  const { data, error } = await supabase.rpc("asin_umsatz_fenster", {
    p_tenant: tenant_id, p_asin: asin, p_von: von, p_bis: bis,
  });
  if (error) throw new Error(`asin_umsatz_fenster: ${error.message}`);
  const r = (data ?? [])[0];
  if (!r) return { umsatz: null, tage: 0 };
  const cents = Number(r.umsatz_cents) || 0;
  const tage = Number(r.tage_mit_verkauf) || 0;
  // Kein einziger Verkaufstag im Fenster ⇒ unbekannt statt 0 (ehrlich).
  return { umsatz: tage > 0 ? cents / 100 : null, tage };
}

/**
 * Loop für EINE ASIN: erledigte Maßnahmen messen, offene weiterreichen.
 * `heute` ist überschreibbar (Tests/Determinismus).
 */
export async function loopDaten(
  supabase: any, tenant_id: string, asin: string, heute = new Date().toISOString().slice(0, 10),
): Promise<unknown> {
  if (!asin) return { vorhanden: false };

  const { data: mRows, error } = await supabase.from("strategie_massnahme")
    .select("id, text, kennzahl, effekt_eur, status, grund, erledigt_am, erstellt_am")
    .eq("tenant_id", tenant_id).eq("asin", asin)
    .order("erstellt_am", { ascending: false });
  if (error) throw new Error(`Maßnahmen: ${error.message}`);
  const massnahmen = (mRows ?? []) as any[];
  if (massnahmen.length === 0) return { vorhanden: false, asin };

  const erledigte = massnahmen.filter((m) => m.status === "erledigt" && m.erledigt_am);
  const messungen: Messung[] = [];
  const details: any[] = [];

  for (const m of erledigte) {
    const stichtag = String(m.erledigt_am).slice(0, 10);
    const tageNachher = Math.min(tageZwischen(stichtag, heute), FENSTER_TAGE);

    // Vorher: die FENSTER_TAGE vor dem Erledigen. Nachher: ab dem Erledigen bis heute (max. Fenster).
    const vor = await fensterUmsatz(supabase, tenant_id, asin, tagPlus(stichtag, -FENSTER_TAGE), tagPlus(stichtag, -1));
    const nach = tageNachher > 0
      ? await fensterUmsatz(supabase, tenant_id, asin, stichtag, tagPlus(stichtag, tageNachher))
      : { umsatz: null, tage: 0 };

    const messung = messeEffekt({
      erwartet_eur_monat: Number(m.effekt_eur) || 0,
      umsatz_vorher: vor.umsatz, tage_vorher: vor.tage,
      umsatz_nachher: nach.umsatz, tage_nachher: tageZwischen(stichtag, heute),
    });
    messungen.push(messung);
    details.push({ id: m.id, text: m.text, kennzahl: m.kennzahl, erledigt_am: m.erledigt_am, ...messung });
  }

  const zusammenfassung = fasseLoopZusammen(massnahmen, messungen);
  return {
    vorhanden: true,
    asin,
    stand: heute,
    zusammenfassung,
    gemessene: details,
    offene: massnahmen.filter((m) => m.status === "offen")
      .map((m) => ({ id: m.id, text: m.text, effekt_eur: m.effekt_eur })),
    verworfene: massnahmen.filter((m) => m.status === "verworfen")
      .map((m) => ({ id: m.id, text: m.text, grund: m.grund })),
  };
}

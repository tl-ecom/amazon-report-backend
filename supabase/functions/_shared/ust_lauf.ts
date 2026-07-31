// ust_lauf.ts — DB-Schicht für den Steuerfaktor der Amazon-Gebühren.
// Die Messregeln liegen rein und getestet in ust_faktor.ts.
//
// Ablauf: messen -> anzeigen -> vom Nutzer bestätigen lassen -> erst dann rechnen.
// Ohne Bestätigung bleibt alles wie gebucht. Ein automatisch angewandter Faktor
// wäre bequem und falsch: bei Reverse Charge oder Kleinunternehmern rechnet er
// Gebühren klein und zeigt eine Marge, die es nicht gibt.

import { FAKTOR_MAX, FAKTOR_MIN, messeUstFaktor, type FaktorErgebnis, type Paar } from "./ust_faktor.ts";

export interface UstStatus {
  messung: FaktorErgebnis;
  /** Bestätigter Faktor, der aktuell gerechnet wird. null = es wird nicht umgerechnet. */
  bestaetigt: number | null;
  quelle: string | null;
  bestaetigt_am: string | null;
  /** Weicht die Messung vom Bestätigten ab? Dann hat sich etwas geändert. */
  abweichung: boolean;
}

/** Misst den Faktor und stellt ihn dem bestätigten gegenüber. */
export async function ustStatus(supabase: any, tenant_id: string): Promise<UstStatus> {
  const [paareRes, einstellung] = await Promise.all([
    supabase.rpc("ust_faktor_paare", { p_tenant: tenant_id }),
    supabase.from("tenant_einstellungen")
      .select("gebuehren_ust_faktor, gebuehren_ust_quelle, gebuehren_ust_bestaetigt_am")
      .eq("tenant_id", tenant_id).maybeSingle(),
  ]);
  if (paareRes.error) throw new Error(`Vergleichspaare: ${paareRes.error.message}`);

  const paare: Paar[] = ((paareRes.data ?? []) as any[]).map((r) => ({
    sku: String(r.sku),
    brutto_cents: Number(r.brutto_cents),
    netto_cents: Number(r.netto_cents),
  }));
  const messung = messeUstFaktor(paare);
  const bestaetigt = einstellung.data?.gebuehren_ust_faktor ?? null;

  return {
    messung,
    bestaetigt: bestaetigt === null ? null : Number(bestaetigt),
    quelle: einstellung.data?.gebuehren_ust_quelle ?? null,
    bestaetigt_am: einstellung.data?.gebuehren_ust_bestaetigt_am ?? null,
    // Nur melden, wenn beide da sind und sich um mehr als eine Rundung unterscheiden.
    abweichung: bestaetigt !== null && messung.vorschlag !== null &&
      Math.abs(Number(bestaetigt) - messung.vorschlag) > 0.005,
  };
}

/**
 * Faktor bestätigen. `faktor = 1` heisst ausdrücklich „keine Umsatzsteuer" —
 * das ist eine gültige Antwort, kein Zurücksetzen. Zum Zurücksetzen: null.
 */
export async function setzeUstFaktor(
  supabase: any, tenant_id: string, faktor: number | null, quelle: string,
): Promise<{ ok: true; faktor: number | null }> {
  let wert: number | null = null;
  if (faktor !== null && faktor !== undefined) {
    const n = Number(faktor);
    if (!Number.isFinite(n) || n < FAKTOR_MIN || n > FAKTOR_MAX) {
      throw new Error(`Ein Faktor von ${faktor} ist kein Steuersatz. Erlaubt: ${FAKTOR_MIN} bis ${FAKTOR_MAX}.`);
    }
    wert = Math.round(n * 1000) / 1000;
  }
  const { error } = await supabase.from("tenant_einstellungen").upsert({
    tenant_id,
    gebuehren_ust_faktor: wert,
    gebuehren_ust_quelle: wert === null ? null : (quelle === "gemessen" ? "gemessen" : "manuell"),
    gebuehren_ust_bestaetigt_am: wert === null ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id" });
  if (error) throw new Error(`Faktor speichern: ${error.message}`);
  return { ok: true, faktor: wert };
}

/** Bestätigten Faktor laden — für die Margenrechnung. null = nicht umrechnen. */
export async function ladeUstFaktor(supabase: any, tenant_id: string): Promise<number | null> {
  const { data } = await supabase.from("tenant_einstellungen")
    .select("gebuehren_ust_faktor").eq("tenant_id", tenant_id).maybeSingle();
  const f = data?.gebuehren_ust_faktor;
  if (f === null || f === undefined) return null;
  const n = Number(f);
  return Number.isFinite(n) && n >= FAKTOR_MIN && n <= FAKTOR_MAX ? n : null;
}

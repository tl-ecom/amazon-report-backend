// ust_lauf.ts — DB-Schicht für den Steuerfaktor der Amazon-Gebühren.
// Die Messregeln liegen rein und getestet in ust_faktor.ts.
//
// Ablauf: messen -> anzeigen -> vom Nutzer bestätigen lassen -> erst dann rechnen.
// Ohne Bestätigung bleibt alles wie gebucht. Ein automatisch angewandter Faktor
// wäre bequem und falsch: bei Reverse Charge oder Kleinunternehmern rechnet er
// Gebühren klein und zeigt eine Marge, die es nicht gibt.

import {
  FAKTOR_MAX, FAKTOR_MIN, faktorAusProfil, messeUstFaktor,
  type FaktorErgebnis, type Paar,
} from "./ust_faktor.ts";

const STANDARD_LAND = "DE";
const STANDARD_VORSTEUER = true;

export interface UstStatus {
  /** Was die Firma über sich angegeben hat. */
  profil: { land: string; vorsteuerabzug: boolean; bestaetigt_am: string | null };
  /** Der aus dem Profil abgeleitete Faktor — das ist die Regel. */
  abgeleitet: number;
  abgeleitet_grund: string;
  /** Manuelle Überschreibung, falls gesetzt. null = es gilt der abgeleitete Wert. */
  ueberschrieben: number | null;
  /** Was tatsächlich gerechnet wird. */
  aktiv: number;
  /** Die Messung an echten Buchungen — Gegenprobe, nicht Grundlage. */
  messung: FaktorErgebnis;
  /** Widerspricht die Messung dem, was gerechnet wird? */
  widerspruch: boolean;
}

/**
 * Steuerprofil lesen und den Faktor daraus ableiten. Die Messung dient als
 * GEGENPROBE, nicht als Grundlage: Sie braucht Abrechnungsdaten, die eine junge
 * Firma noch nicht hat — das Profil kennt jeder Verkäufer sofort.
 */
export async function ustStatus(supabase: any, tenant_id: string): Promise<UstStatus> {
  const [paareRes, einstellung] = await Promise.all([
    supabase.rpc("ust_faktor_paare", { p_tenant: tenant_id }),
    supabase.from("tenant_einstellungen")
      .select("firmensitz_land, vorsteuerabzug, steuerprofil_bestaetigt_am, gebuehren_ust_faktor")
      .eq("tenant_id", tenant_id).maybeSingle(),
  ]);
  if (paareRes.error) throw new Error(`Vergleichspaare: ${paareRes.error.message}`);

  const paare: Paar[] = ((paareRes.data ?? []) as any[]).map((r) => ({
    sku: String(r.sku),
    brutto_cents: Number(r.brutto_cents),
    netto_cents: Number(r.netto_cents),
  }));
  const messung = messeUstFaktor(paare);

  const land = einstellung.data?.firmensitz_land ?? STANDARD_LAND;
  const vorsteuer = einstellung.data?.vorsteuerabzug ?? STANDARD_VORSTEUER;
  const ableitung = faktorAusProfil({ land, vorsteuerabzug: vorsteuer });
  const ueberschrieben = einstellung.data?.gebuehren_ust_faktor ?? null;
  const aktiv = ueberschrieben === null ? ableitung.faktor : Number(ueberschrieben);

  return {
    profil: {
      land, vorsteuerabzug: vorsteuer,
      bestaetigt_am: einstellung.data?.steuerprofil_bestaetigt_am ?? null,
    },
    abgeleitet: ableitung.faktor,
    abgeleitet_grund: ableitung.begruendung,
    ueberschrieben: ueberschrieben === null ? null : Number(ueberschrieben),
    aktiv,
    messung,
    // Nur wenn die Messung belastbar ist UND deutlich abweicht. Ein Widerspruch
    // heisst: entweder stimmt das Profil nicht oder Amazon rechnet anders ab.
    widerspruch: messung.brauchbar && messung.vorschlag !== null &&
      Math.abs(messung.vorschlag - aktiv) > 0.005,
  };
}

/** Steuerprofil setzen. Das ist die Angabe der Firma über sich selbst. */
export async function setzeSteuerprofil(
  supabase: any, tenant_id: string, land: unknown, vorsteuerabzug: unknown,
): Promise<{ ok: true; faktor: number }> {
  const l = String(land ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(l)) throw new Error("Bitte ein Land als Zwei-Buchstaben-Kürzel angeben (z. B. DE).");
  const v = Boolean(vorsteuerabzug);
  const { error } = await supabase.from("tenant_einstellungen").upsert({
    tenant_id, firmensitz_land: l, vorsteuerabzug: v,
    steuerprofil_bestaetigt_am: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id" });
  if (error) throw new Error(`Steuerprofil speichern: ${error.message}`);
  return { ok: true, faktor: faktorAusProfil({ land: l, vorsteuerabzug: v }).faktor };
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

/**
 * Faktor für die Margenrechnung. Reihenfolge: manuelle Überschreibung, sonst
 * aus dem Steuerprofil abgeleitet. Das Profil hat immer eine Antwort — deshalb
 * gibt es hier kein „unbekannt" mehr.
 */
export async function ladeUstFaktor(supabase: any, tenant_id: string): Promise<number | null> {
  const { data } = await supabase.from("tenant_einstellungen")
    .select("gebuehren_ust_faktor, firmensitz_land, vorsteuerabzug")
    .eq("tenant_id", tenant_id).maybeSingle();

  const f = data?.gebuehren_ust_faktor;
  if (f !== null && f !== undefined) {
    const n = Number(f);
    if (Number.isFinite(n) && n >= FAKTOR_MIN && n <= FAKTOR_MAX) return n;
  }
  return faktorAusProfil({
    land: data?.firmensitz_land ?? STANDARD_LAND,
    vorsteuerabzug: data?.vorsteuerabzug ?? STANDARD_VORSTEUER,
  }).faktor;
}

// ladenhueter.ts — Ladenhüter-/Dead-Stock-Radar (DataDoe #5).
//
// Gegenstück zum Nachschub-Radar (#4): Während #4 sagt „lief gut, plötzlich weg
// -> nachbestellen", sagt #5 „Nachfrage ist versiegt -> nicht nachbestellen,
// prüfen ob liquidieren/auslisten". Zwei Klassen:
//   tot        — seit >= 60 Tagen kein Verkauf, hatte aber Historie.
//   abkühlend  — verkaufte im Vorquartal ordentlich, jetzt <= 30 % davon.
//
// EHRLICH: Ohne Live-Bestand können wir kein „gebundenes Kapital" in Einheiten
// messen. Wir zeigen daher Nachfrage-Signale (Velocity-Verfall) + den realen
// Monatsumsatz-Einbruch, wo Preisdaten vorliegen. Kein erfundener Bestandswert.

export const MIN_LIFETIME = 20;   // < 20 je ASIN verkauft: nie richtig gelaufen, kein „Ladenhüter"
export const TOT_TAGE = 60;       // >= 60 Tage kein Verkauf -> tot
export const ALT_MIN_VELO = 0.2;  // Vorquartal-Velocity (Stk/Tag), ab der „abkühlend" überhaupt zählt
export const KUEHL_FAKTOR = 0.3;  // jetzt <= 30 % der alten Velocity -> abkühlend
export const LUECKE_TAGE = 14;    // Null-Strecke, ab der eine VERSORGUNGSlücke (Ausverkauf) unterstellt wird

// „wiederanlauf" trennt „keine Ware" von „keine Nachfrage": Der Einbruch wird durch
// eine lange Verkaufslücke erklärt UND das Produkt verkauft inzwischen wieder.
// Ohne diese Unterscheidung wurde ein Stockout als Ladenhüter gemeldet — mit der
// genau falschen Empfehlung („auslisten" statt „nachbestellen").
// „ausgelistet": Es gibt gar kein Angebot mehr. Dann ist „Relaunch oder
// auslisten" sinnlos — die Entscheidung ist längst gefallen. Solche ASINs
// tauchen nur noch als Historie auf und werden nachrangig gezeigt.
export type LhStatus = "tot" | "wiederanlauf" | "abkuehlend" | "ausgelistet" | "ok";

export interface LhInput {
  lifetime_units: number;
  units_0_30: number;
  umsatz_0_30_cents: number;
  units_30_120: number;
  umsatz_30_120_cents: number;
  tage_ohne_verkauf: number;
  /** Längste Strecke ohne Verkauf in den letzten 120 Tagen. */
  max_luecke_tage?: number;
  /** Verkauft sich jetzt unter einer SKU, die es vorher nicht gab (neue Charge). */
  neue_sku?: boolean;
  /** Steht die ASIN noch im Angebots-Snapshot? false = ausgelistet. */
  hat_angebot?: boolean;
}
export interface LhBewertung {
  status: LhStatus;
  schwere: number;                // 2 tot/wiederanlauf, 1 abkühlend, 0 ok
  einbruch_cents: number;         // Monatsumsatz Vorquartal − jetzt (>= 0), soweit Preisdaten da sind
  umsatz_alt_monat_cents: number; // Ø Monatsumsatz im Vorquartal (30–120 Tage)
  velo_alt: number;               // Stk/Tag Vorquartal
  velo_neu: number;               // Stk/Tag letzte 30 Tage
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Reine Einstufung EINER ASIN. */
export function bewerteLadenhueter(i: LhInput): LhBewertung {
  const lifetime = nz(i.lifetime_units);
  const veloAlt = nz(i.units_30_120) / 90;
  const veloNeu = nz(i.units_0_30) / 30;
  const umsatzAltMonat = Math.round(nz(i.umsatz_30_120_cents) / 3); // 90 Tage -> 30 Tage
  const einbruch = Math.max(0, umsatzAltMonat - nz(i.umsatz_0_30_cents));
  const basis = { einbruch_cents: einbruch, umsatz_alt_monat_cents: umsatzAltMonat, velo_alt: veloAlt, velo_neu: veloNeu };

  if (lifetime < MIN_LIFETIME) return { status: "ok", schwere: 0, ...basis };

  const tageOhne = nz(i.tage_ohne_verkauf);
  if (tageOhne >= TOT_TAGE) {
    // Kein Angebot mehr -> bereits ausgelistet, keine offene Entscheidung.
    // `hat_angebot === undefined` heißt „unbekannt" und bleibt bewusst „tot".
    if (i.hat_angebot === false) return { status: "ausgelistet", schwere: 0, ...basis };
    return { status: "tot", schwere: 2, ...basis };
  }

  const eingebrochen = veloAlt >= ALT_MIN_VELO && veloNeu <= KUEHL_FAKTOR * veloAlt;
  if (eingebrochen) {
    // Erklärt eine Versorgungslücke den Einbruch — und läuft der Verkauf wieder an?
    // Dann ist es ein Ausverkauf, kein Ladenhüter.
    const luecke = nz(i.max_luecke_tage);
    if (luecke >= LUECKE_TAGE && tageOhne < LUECKE_TAGE) {
      return { status: "wiederanlauf", schwere: 2, ...basis };
    }
    return { status: "abkuehlend", schwere: 1, ...basis };
  }
  return { status: "ok", schwere: 0, ...basis };
}

/** DB-Wrapper: RPC-Basis + Produktnamen zusammenführen, einstufen, Auffällige zurück. */
export async function ladenhueterRadar(supabase: any, tenant_id: string): Promise<unknown> {
  const [basisRes, asinRes] = await Promise.all([
    supabase.rpc("ladenhueter_basis", { p_tenant: tenant_id }),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
  ]);
  const basis = (basisRes.data ?? []) as any[];
  const titel = new Map<string, string>(
    ((asinRes.data ?? []) as any[]).map((a) => [String(a.asin), String(a.produktname ?? a.asin)]),
  );

  const zeilen = basis.map((r) => {
    const b = bewerteLadenhueter({
      lifetime_units: nz(r.lifetime_units),
      units_0_30: nz(r.units_0_30),
      umsatz_0_30_cents: nz(r.umsatz_0_30_cents),
      units_30_120: nz(r.units_30_120),
      umsatz_30_120_cents: nz(r.umsatz_30_120_cents),
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
      max_luecke_tage: nz(r.max_luecke_tage),
      neue_sku: Boolean(r.neue_sku),
      hat_angebot: r.hat_angebot === null || r.hat_angebot === undefined ? undefined : Boolean(r.hat_angebot),
    });
    const preisAlt = r.preis_alt_cents == null ? null : nz(r.preis_alt_cents);
    const preisNeu = r.preis_neu_cents == null ? null : nz(r.preis_neu_cents);
    return {
      asin: String(r.asin),
      produktname: titel.get(String(r.asin)) ?? String(r.asin),
      lifetime_units: nz(r.lifetime_units),
      units_0_30: nz(r.units_0_30),
      units_30_120: nz(r.units_30_120),
      letzter_verkauf: r.letzter_verkauf ?? null,
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
      // Belege für das Urteil — sichtbar, damit die Einstufung nachprüfbar ist.
      max_luecke_tage: nz(r.max_luecke_tage),
      neue_sku: Boolean(r.neue_sku),
      preis_alt_cents: preisAlt,
      preis_neu_cents: preisNeu,
      preis_geaendert: preisAlt != null && preisNeu != null && Math.abs(preisNeu - preisAlt) >= 100,
      // Angebot/Bestand: FBA-Mengen liefert der Report NICHT -> bestand bleibt null
      // (unbekannt), niemals 0. `hat_angebot=false` = ausgelistet.
      hat_angebot: Boolean(r.hat_angebot),
      angebot_status: r.angebot_status ?? null,
      bestand: r.bestand == null ? null : nz(r.bestand),
      nachschub_unterwegs: r.nachschub_unterwegs == null ? null : nz(r.nachschub_unterwegs),
      bestand_bekannt: Boolean(r.bestand_bekannt),
      ist_fba: Boolean(r.ist_fba),
      status: b.status,
      schwere: b.schwere,
      einbruch_cents: b.einbruch_cents,
      umsatz_alt_monat_cents: b.umsatz_alt_monat_cents,
    };
  }).filter((z) => z.status !== "ok");

  zeilen.sort((a, b) =>
    (b.schwere - a.schwere) || (b.einbruch_cents - a.einbruch_cents) || (b.lifetime_units - a.lifetime_units)
  );

  const zaehle = (s: LhStatus) => zeilen.filter((z) => z.status === s).length;
  return {
    waehrung: "EUR",
    zeilen,
    // Nur der Umsatz-Einbruch der abkühlenden Produkte (verlässliche, jüngste Preisdaten).
    // Wiederanlauf zählt NICHT hierein — das ist Ausverkauf, kein Nachfrageverlust.
    summe_einbruch_cents: zeilen.filter((z) => z.status === "abkuehlend").reduce((s, z) => s + z.einbruch_cents, 0),
    // Entgangener Umsatz durch Ausverkauf — getrennt ausgewiesen, andere Ursache/Handlung.
    summe_ausverkauf_cents: zeilen.filter((z) => z.status === "wiederanlauf").reduce((s, z) => s + z.einbruch_cents, 0),
    anzahl_tot: zaehle("tot"),
    anzahl_abkuehlend: zaehle("abkuehlend"),
    anzahl_wiederanlauf: zaehle("wiederanlauf"),
    anzahl_ausgelistet: zaehle("ausgelistet"),
    anzahl_asins_geprueft: basis.length,
    // Woher der Bestand stammt und wie alt er ist — wie beim Nachschub.
    //
    // Amazons FBA-Bestandsbericht faellt blockweise aus; dann greift der
    // Planungsreport als Zweitquelle. Ein Ladenhueter-Befund fuehrt zu
    // Entscheidungen ueber Abverkauf und Entfernung. Die trifft man nicht gern
    // auf einem Stand, von dem man nicht weiss, wie alt er ist.
    bestand_quelle: (basis.find((r: any) => r.bestand_quelle)?.bestand_quelle as string) ?? null,
    bestand_stand: (basis.find((r: any) => r.bestand_stand)?.bestand_stand as string) ?? null,
    // Ein Ladenhueter MIT Zulauf ist ein anderer Fall als einer ohne — da kommt
    // noch Ware, die auch liegen bleibt. Der Planungsreport kennt den Zulauf
    // nicht; dann ist er unbekannt, nicht null.
    zulauf_bekannt: basis.some((r: any) => r.nachschub_unterwegs != null),
  };
}

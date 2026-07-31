// lageralter.ts — Aufteilung der Lagergebühr nach Bestandsalter.
//
// Coaching-Regel (TL): Die ersten drei Monate Lagerung sind der Preis des
// Verkaufens — Ware muss liegen, bevor sie verkauft wird. Ab dem vierten Monat
// ist die Lagergebühr selbst erzeugt: der Bestand liegt zu lange.
//
// Amazons Altersstufen decken sich damit: 0–30, 31–60 und 61–90 Tage sind die
// ersten drei Monate, alles ab 91 Tagen liegt darüber.
//
// Die Gebühr wird NICHT je Alter ausgewiesen — Amazon nennt nur eine Summe je
// ASIN und Monat. Aufgeteilt wird deshalb nach MENGENANTEIL. Das ist eine
// Näherung, und sie wird als solche gekennzeichnet: ein Karton kostet Lagerplatz
// unabhängig davon, wie lange er schon steht, also ist der Mengenanteil der
// ehrlichste verfügbare Schlüssel.

/** Tage, bis Lagerung als „zu lange" gilt. Drei Monate. */
export const FRISCH_BIS_TAGE = 90;

export interface Altersstufen {
  alter_0_30: number | null;
  alter_31_60: number | null;
  alter_61_90: number | null;
  alter_91_180: number | null;
  alter_181_270: number | null;
  alter_271_365: number | null;
  alter_365_plus: number | null;
}

export interface Aufteilung {
  /** Anteil (0..1) des Bestands, der länger als drei Monate liegt. */
  anteil_alt: number | null;
  menge_frisch: number;
  menge_alt: number;
  /** Wieviel von der Gebühr entfällt auf die ersten drei Monate. */
  frisch_cents: number;
  /** ...und wieviel auf alles darüber. Das ist der steuerbare Teil. */
  alt_cents: number;
  /** true = Bestandsalter unbekannt, alles gilt vorsichtshalber als frisch. */
  geschaetzt: boolean;
}

function nz(x: number | null | undefined): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}

/**
 * Teilt eine Lagergebühr in „erste drei Monate" und „darüber".
 *
 * Ohne bekanntes Bestandsalter wird die GESAMTE Gebühr als frisch gewertet.
 * Das ist die vorsichtige Richtung: sie schreibt dem Verkäufer nichts zu, was
 * nicht belegt ist. Der Rückgabewert markiert das als geschätzt.
 */
export function teileLagergebuehr(
  gebuehr_cents: number,
  alter: Altersstufen | null,
): Aufteilung {
  if (!alter) {
    return {
      anteil_alt: null, menge_frisch: 0, menge_alt: 0,
      frisch_cents: gebuehr_cents, alt_cents: 0, geschaetzt: true,
    };
  }
  const frisch = nz(alter.alter_0_30) + nz(alter.alter_31_60) + nz(alter.alter_61_90);
  const alt = nz(alter.alter_91_180) + nz(alter.alter_181_270)
    + nz(alter.alter_271_365) + nz(alter.alter_365_plus);
  const gesamt = frisch + alt;

  if (gesamt <= 0) {
    return {
      anteil_alt: null, menge_frisch: 0, menge_alt: 0,
      frisch_cents: gebuehr_cents, alt_cents: 0, geschaetzt: true,
    };
  }
  const anteil = alt / gesamt;
  const altCents = Math.round(gebuehr_cents * anteil);
  return {
    anteil_alt: Math.round(anteil * 1000) / 1000,
    menge_frisch: frisch,
    menge_alt: alt,
    frisch_cents: gebuehr_cents - altCents,
    alt_cents: altCents,
    geschaetzt: false,
  };
}

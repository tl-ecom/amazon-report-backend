// wiedervorlage.ts — der LOOP: Pulse misst sich an seinen eigenen Empfehlungen.
//
// Brief: „Letzter Lauf, 12.06.: drei Maßnahmen. Zwei erledigt. Erledigte
// Maßnahmen, erwarteter Effekt +840 €/Monat, tatsächliche Veränderung +610 €/Monat."
//
// EHRLICHKEIT — die Grenzen dieser Messung stehen ausdrücklich in der Ausgabe:
//   * Es ist ein VORHER/NACHHER-Vergleich, KEIN Kausalitätsnachweis. Saison,
//     Wettbewerb und Preis wirken mit. Wir behaupten nie „X hat Y bewirkt".
//   * Zu kurz nach dem Erledigen wird NICHT gemessen (Ergebnis 'zu_frueh'),
//     statt eine Zahl aus wenigen Tagen hochzurechnen.
//   * Fehlende Daten ⇒ 'nicht_messbar', nie 0.
//
// Reine Funktionen; DB-Zugriff liegt in wiedervorlage_lauf.ts.

/** Mindest-Beobachtung nach dem Erledigen, bevor gemessen wird. */
export const MIN_TAGE_NACHHER = 14;
/** Fenstergröße vor/nach dem Erledigen (Tage). */
export const FENSTER_TAGE = 30;

export type MessErgebnis = "gemessen" | "zu_frueh" | "nicht_messbar";

export interface Messung {
  ergebnis: MessErgebnis;
  /** Tatsächliche Veränderung in EUR pro Monat (normalisiert). null wenn nicht gemessen. */
  tatsaechlich_eur_monat: number | null;
  /** Erwarteter Effekt aus der Maßnahme. */
  erwartet_eur_monat: number;
  /** Umsatz je Monat vor/nach dem Erledigen (normalisiert), für die Transparenz. */
  vorher_eur_monat: number | null;
  nachher_eur_monat: number | null;
  tage_nachher: number;
  hinweis: string | null;
}

function runde(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Rechnet einen Fensterumsatz auf 30 Tage hoch. null bei fehlenden/0 Tagen —
 * niemals 0 erfinden.
 */
export function proMonat(umsatz: number | null, tage: number): number | null {
  if (umsatz == null || tage <= 0) return null;
  return runde((umsatz / tage) * FENSTER_TAGE);
}

/**
 * Misst den tatsächlichen Effekt einer erledigten Maßnahme.
 * `tage_nachher` = vergangene Tage seit dem Erledigen (deterministisch übergeben).
 */
export function messeEffekt(p: {
  erwartet_eur_monat: number;
  umsatz_vorher: number | null;
  tage_vorher: number;
  umsatz_nachher: number | null;
  tage_nachher: number;
}): Messung {
  const erwartet = runde(Number(p.erwartet_eur_monat) || 0);
  const basis = {
    erwartet_eur_monat: erwartet,
    vorher_eur_monat: proMonat(p.umsatz_vorher, p.tage_vorher),
    nachher_eur_monat: proMonat(p.umsatz_nachher, p.tage_nachher),
    tage_nachher: p.tage_nachher,
  };

  if (p.tage_nachher < MIN_TAGE_NACHHER) {
    return {
      ...basis, ergebnis: "zu_frueh", tatsaechlich_eur_monat: null,
      hinweis: `Erst ${p.tage_nachher} von ${MIN_TAGE_NACHHER} Tagen beobachtet — noch keine belastbare Messung.`,
    };
  }
  if (basis.vorher_eur_monat == null || basis.nachher_eur_monat == null) {
    return {
      ...basis, ergebnis: "nicht_messbar", tatsaechlich_eur_monat: null,
      hinweis: "Zu wenig Umsatzdaten im Vorher- oder Nachher-Fenster.",
    };
  }
  return {
    ...basis, ergebnis: "gemessen",
    tatsaechlich_eur_monat: runde(basis.nachher_eur_monat - basis.vorher_eur_monat),
    hinweis: null,
  };
}

export interface LoopZusammenfassung {
  massnahmen_gesamt: number;
  erledigt: number;
  verworfen: number;
  offen: number;
  /** Summe der erwarteten Effekte der ERLEDIGTEN Maßnahmen. */
  erwartet_eur_monat: number;
  /** Summe der tatsächlichen Veränderungen — nur über MESSBARE Maßnahmen. */
  tatsaechlich_eur_monat: number | null;
  /** Wie viele erledigte Maßnahmen tatsächlich gemessen werden konnten. */
  gemessen: number;
  zu_frueh: number;
  nicht_messbar: number;
  hinweis: string;
}

/**
 * Verdichtet die Messungen zu der Zeile, die der Seller oben sieht.
 * Wichtig: `tatsaechlich` summiert NUR gemessene Maßnahmen — sonst wäre die
 * Zahl eine Mischung aus Gemessenem und Unbekanntem.
 */
export function fasseLoopZusammen(
  massnahmen: Array<{ status: string }>,
  messungen: Messung[],
): LoopZusammenfassung {
  const gemessen = messungen.filter((m) => m.ergebnis === "gemessen");
  const erwartetSumme = runde(messungen.reduce((s, m) => s + m.erwartet_eur_monat, 0));
  const tatsaechlichSumme = gemessen.length
    ? runde(gemessen.reduce((s, m) => s + (m.tatsaechlich_eur_monat ?? 0), 0))
    : null;

  return {
    massnahmen_gesamt: massnahmen.length,
    erledigt: massnahmen.filter((m) => m.status === "erledigt").length,
    verworfen: massnahmen.filter((m) => m.status === "verworfen").length,
    offen: massnahmen.filter((m) => m.status === "offen").length,
    erwartet_eur_monat: erwartetSumme,
    tatsaechlich_eur_monat: tatsaechlichSumme,
    gemessen: gemessen.length,
    zu_frueh: messungen.filter((m) => m.ergebnis === "zu_frueh").length,
    nicht_messbar: messungen.filter((m) => m.ergebnis === "nicht_messbar").length,
    hinweis: "Vorher/Nachher-Vergleich des Produktumsatzes — kein Kausalitätsnachweis. Saison, Preis und Wettbewerb wirken mit.",
  };
}

/** 'YYYY-MM-DD' mit Tages-Offset (rein, Basis wird übergeben). */
export function tagPlus(datum: string, tage: number): string {
  const d = new Date(datum + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

/** Ganze Tage zwischen zwei 'YYYY-MM-DD' (bis − von); nie negativ. */
export function tageZwischen(von: string, bis: string): number {
  const a = Date.parse(von + "T00:00:00Z");
  const b = Date.parse(bis + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

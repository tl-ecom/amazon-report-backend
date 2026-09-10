// cashflow_liquiditaet.ts — aus Bewegungen wird ein Kontoverlauf.
//
// Der Zahlungskalender sagt, WAS sich wann bewegt. Die Frage dahinter ist eine
// andere: reicht es. "Ist am 20. das Geld für die Containerrechnung da?" lässt
// sich aus einer Liste von Bewegungen nicht ablesen — dafür braucht es einen
// Startwert und einen fortlaufenden Saldo.
//
// Den Startwert kennt Pulse nicht und kann ihn auch nicht messen: was auf dem
// Geschäftskonto liegt, steht in keinem Amazon-Bericht. Deshalb kommt er vom
// Verkäufer selbst. Ohne ihn wird hier NICHTS gezeigt — ein Verlauf ab 0 € wäre
// eine erfundene Zahl, und zwar eine, nach der man Entscheidungen trifft.
//
// Zwei Dinge trennt diese Datei streng:
//
//  - Der Kontostand ist der BANK-Stand: Geld, das schon angekommen ist. Was noch
//    bei Amazon liegt, kommt über die Auszahlungen im Kalender herein. Beides zu
//    addieren hiesse, dasselbe Geld zweimal zu zählen.
//
//  - Ein Tag, vor dem eine Bewegung mit unbekanntem Betrag liegt, ist nicht mehr
//    gerechnet, sondern geschätzt. Das steht je Tag dran (`sicher`), statt am
//    Ende in einer Fussnote.

function r2(n: number): number { return Math.round(n * 100) / 100; }

const TAG = 86400000;

/**
 * Ab wann ein gemeldeter Kontostand kommentiert wird.
 *
 * Zwischen dem Stichtag und heute hat sich das Konto bewegt — Auszahlungen,
 * Lastschriften, Privatentnahmen. Pulse sieht davon nichts. Bis zu drei Tagen
 * ist das eine Kleinigkeit, danach gehoert es dazugesagt.
 */
export const VERALTET_WARNUNG_TAGE = 3;

/**
 * Ab wann gar kein Verlauf mehr gezeichnet wird.
 *
 * Ein Monat alter Stand plus zwei Auszahlungen, die niemand kennt: daraus einen
 * Saldo zu bilden waere kein Schaetzwert mehr, sondern eine Behauptung.
 */
export const VERALTET_MAX_TAGE = 30;

export interface LiquiditaetsPosition {
  am: string;
  art: string;
  bezeichnung: string;
  betrag: number | null;
}

export interface LiquiditaetsTag {
  am: string;
  /** Summe der Bewegungen dieses Tages. */
  bewegung: number;
  /** Saldo NACH den Bewegungen des Tages. */
  saldo: number;
  /**
   * true = bis hierher ist jeder Betrag bekannt. false = davor liegt mindestens
   * eine Bewegung ohne Betrag, der Saldo ist dann eine Untergrenze der
   * Genauigkeit, keine Rechnung.
   */
  sicher: boolean;
}

export interface Liquiditaet {
  /** Gemeldeter Kontostand. null = nicht hinterlegt, dann bleibt alles leer. */
  start: number | null;
  start_am: string | null;
  /** Wie alt der gemeldete Stand ist. null = kein Stand. */
  veraltet_tage: number | null;
  /** Mindestpuffer, den der Verkäufer halten will. null = keine Vorgabe. */
  puffer: number | null;
  verlauf: LiquiditaetsTag[];
  /** Tiefster Saldo im Fenster — die Zahl, an der eine Bestellung scheitert. */
  tiefpunkt: { am: string; saldo: number } | null;
  /** Erster Tag unter dem Puffer bzw. unter null. null = kommt nicht vor. */
  unter_puffer_ab: string | null;
  unter_null_ab: string | null;
  /** Bewegungen im Fenster, zu denen kein Betrag feststeht. */
  offene_posten: number;
  hinweise: string[];
}

function leer(hinweise: string[]): Liquiditaet {
  return {
    start: null, start_am: null, veraltet_tage: null, puffer: null,
    verlauf: [], tiefpunkt: null, unter_puffer_ab: null, unter_null_ab: null,
    offene_posten: 0, hinweise,
  };
}

function tageZwischen(vonIso: string, bisIso: string): number {
  return Math.round(
    (Date.parse(`${bisIso}T00:00:00Z`) - Date.parse(`${vonIso}T00:00:00Z`)) / TAG,
  );
}

/**
 * Kontoverlauf aus Startwert plus Kalenderbewegungen.
 *
 * Gibt bewusst einen leeren Verlauf mit Begruendung zurueck, statt einen Saldo
 * zu erfinden: ohne Startwert, mit zu altem Startwert oder ohne Bewegungen gibt
 * es hier nichts zu zeigen.
 */
export function liquiditaetsverlauf(
  positionen: LiquiditaetsPosition[],
  start: number | null,
  start_am: string | null,
  puffer: number | null,
  heute = new Date(),
): Liquiditaet {
  if (start === null || !start_am) {
    return leer([
      "Kein Kontostand hinterlegt. Der Kalender zeigt deshalb nur Bewegungen, "
      + "keinen Verlauf — ein Saldo ab 0 € waere eine erfundene Zahl. Der Stand "
      + "des Geschäftskontos lässt sich in den Einstellungen eintragen.",
    ]);
  }

  const heuteIso = new Date(heute).toISOString().slice(0, 10);
  const alter = tageZwischen(start_am, heuteIso);

  if (alter < 0) {
    return leer([
      `Der hinterlegte Kontostand ist auf den ${start_am} datiert und liegt damit `
      + "in der Zukunft. Aus einem Stand, den es noch nicht gibt, wird hier kein "
      + "Verlauf gerechnet.",
    ]);
  }
  if (alter > VERALTET_MAX_TAGE) {
    return leer([
      `Der hinterlegte Kontostand ist ${alter} Tage alt (Stand ${start_am}). `
      + "Seitdem sind Auszahlungen eingegangen und Rechnungen abgegangen, die "
      + "Pulse nicht sieht. Ein Verlauf darauf waere keine Schätzung mehr, "
      + "sondern eine Behauptung — bitte den Stand aktualisieren.",
    ]);
  }

  const hinweise: string[] = [];
  if (alter > VERALTET_WARNUNG_TAGE) {
    hinweise.push(
      `Der Kontostand ist vom ${start_am} und damit ${alter} Tage alt. Was seitdem `
      + "auf dem Konto passiert ist, steckt nicht im Verlauf.",
    );
  }

  // Nur Bewegungen ab heute: was davor lag, ist im gemeldeten Stand entweder
  // schon enthalten oder gehoert in die Luecke oben.
  const kommend = positionen.filter((p) => p.am >= heuteIso)
    .sort((a, b) => a.am.localeCompare(b.am));

  if (kommend.length === 0) {
    return leer([
      "Im Kalenderfenster liegt keine Bewegung. Ohne Zu- und Abfluesse gibt es "
      + "keinen Verlauf zu zeigen.",
    ]);
  }

  const offene = kommend.filter((p) => p.betrag === null);
  if (offene.length > 0) {
    const namen = [...new Set(offene.map((p) => p.bezeichnung))].join(", ");
    hinweise.push(
      `${offene.length} Bewegung(en) im Fenster haben keinen Betrag (${namen}). `
      + "Ab dem ersten davon ist der Saldo nicht mehr gerechnet, sondern zu hoch "
      + "— die Tage danach sind als unsicher gekennzeichnet.",
    );
  }

  // --- Verlauf ------------------------------------------------------------
  const jeTag = new Map<string, { bewegung: number; offen: boolean }>();
  for (const p of kommend) {
    const t = jeTag.get(p.am) ?? { bewegung: 0, offen: false };
    if (p.betrag === null) t.offen = true;
    else t.bewegung += p.betrag;
    jeTag.set(p.am, t);
  }

  let saldo = start;
  let sicher = true;
  const verlauf: LiquiditaetsTag[] = [];
  for (const am of [...jeTag.keys()].sort()) {
    const t = jeTag.get(am)!;
    saldo = r2(saldo + t.bewegung);
    // Ein offener Posten AN diesem Tag macht schon diesen Tag unsicher: der
    // fehlende Betrag ist an dem Tag faellig, nicht am naechsten.
    if (t.offen) sicher = false;
    verlauf.push({ am, bewegung: r2(t.bewegung), saldo, sicher });
  }

  const tiefster = verlauf.reduce((a, b) => (b.saldo < a.saldo ? b : a));
  const unterNull = verlauf.find((t) => t.saldo < 0) ?? null;
  const unterPuffer = puffer === null ? null : (verlauf.find((t) => t.saldo < puffer) ?? null);

  if (unterNull) {
    hinweise.push(
      `Nach dieser Rechnung ist das Konto am ${unterNull.am} im Minus `
      + `(${unterNull.saldo.toFixed(2)} €). Das ist kein Gewinnproblem: der Umsatz `
      + "läuft weiter, das Geld ist nur noch nicht da.",
    );
  } else if (unterPuffer) {
    hinweise.push(
      `Der Puffer von ${puffer!.toFixed(0)} € wird am ${unterPuffer.am} `
      + `unterschritten (${unterPuffer.saldo.toFixed(2)} €).`,
    );
  }

  return {
    start: r2(start),
    start_am,
    veraltet_tage: alter,
    puffer: puffer === null ? null : r2(puffer),
    verlauf,
    tiefpunkt: { am: tiefster.am, saldo: tiefster.saldo },
    unter_puffer_ab: unterPuffer?.am ?? null,
    unter_null_ab: unterNull?.am ?? null,
    offene_posten: offene.length,
    hinweise,
  };
}

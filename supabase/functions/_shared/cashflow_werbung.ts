// cashflow_werbung.ts — was eine Budgeterhöhung mit dem Konto macht.
//
// Die Frage kommt in jedem Coaching: "soll ich das Werbebudget hochdrehen?"
// Die übliche Antwort rechnet mit ACOS und Marge und ist damit nur die halbe
// Antwort. Die andere Hälfte ist Zeit: Werbung wird SOFORT abgebucht, der
// Umsatz daraus kommt über den gemessenen Geldlauf zurück — bei Vaneja im
// Mittel 18 Tage später. Jede Erhöhung bindet deshalb dauerhaft Kapital, und
// zwar unabhängig davon, ob sie sich rechnet.
//
// Diese Datei sagt zwei Dinge, beide aus gemessenen Werten:
//
//  1. WIEVIEL GELD eine Erhöhung dauerhaft bindet. Das ist reine Arithmetik
//     aus dem gemessenen Geldlauf und gilt auch dann, wenn die Werbung
//     hervorragend läuft.
//
//  2. AB WELCHEM ACOS sich ein zusätzlicher Werbe-Euro trägt. Das ist der
//     Deckungsbeitrag vor Werbung, gemessen am letzten abgerechneten Monat.
//
// Was hier bewusst NICHT steht: ob mehr Budget mehr Umsatz bringt. Das weiß
// niemand vorher, und eine Zahl dafür wäre erfunden. Die Rechnung dreht sich
// deshalb um: nicht "das bringt X", sondern "damit es sich trägt, muss es
// mindestens X bringen". Diesen Satz kann man prüfen, den anderen nicht.

function r2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Die Stufen, die durchgerechnet werden.
 *
 * Bewusst absolute Euro-Beträge und keine Prozente: "20 % mehr Budget" heißt
 * bei jedem Konto etwas anderes, "100 € am Tag" ist eine Entscheidung, die
 * jemand tatsächlich so trifft.
 */
export const STUFEN = [50, 100, 200, 500];

export interface WerbeSzenario {
  /** Erhöhung je Tag in Euro. */
  delta_je_tag: number;
  /** Budget je Tag danach. */
  budget_je_tag: number | null;
  /** Zusätzlich dauerhaft gebundenes Kapital: Erhöhung mal Geldlauf. */
  gebunden_zusaetzlich: number | null;
  /** Gebundenes Kapital für Werbung insgesamt, nach der Erhöhung. */
  gebunden_gesamt: number | null;
  /**
   * Zusatzumsatz je Tag (netto), den diese Erhöhung mindestens bringen muss,
   * damit sie sich trägt. null = Deckungsbeitrag nicht messbar.
   */
  noetiger_mehrumsatz_je_tag: number | null;
}

export interface WerbeSimulation {
  je_tag_aktuell: number | null;
  median_tage: number | null;
  /** Deckungsbeitrag VOR Werbung als Anteil vom Nettoumsatz. */
  db_quote: number | null;
  /** Monat, an dem der Deckungsbeitrag gemessen wurde. */
  db_monat: string | null;
  /**
   * Höchster ACOS, bei dem ein zusätzlicher Werbe-Euro noch etwas übrig lässt.
   * Identisch mit der Deckungsbeitragsquote — das ist kein Zufall, sondern die
   * Definition: mehr als den Deckungsbeitrag kann Werbung nicht zurückholen.
   */
  break_even_acos: number | null;
  /** Werbeanteil am Nettoumsatz im gemessenen Monat. */
  tacos: number | null;
  /**
   * Wieviel mehr je Tag möglich wäre, bis das Monatsergebnis bei null steht —
   * BEI GLEICHEM UMSATZ. Das ist die Untergrenze, nicht die Empfehlung.
   */
  puffer_je_tag: number | null;
  szenarien: WerbeSzenario[];
  hinweise: string[];
  grund: string | null;
}

export interface DbEingabe {
  monat: string;
  /** Nettoumsatz des Monats (brutto minus Umsatzsteuer). */
  netto_umsatz: number;
  /** Deckungsbeitrag VOR Werbung. */
  db_vor_werbung: number;
  /** Werbekosten des Monats. */
  werbung: number;
  /** Tage im Monat — für die Umrechnung auf den Tag. */
  tage_im_monat: number;
}

function leer(grund: string, je_tag: number | null, median: number | null): WerbeSimulation {
  return {
    je_tag_aktuell: je_tag, median_tage: median,
    db_quote: null, db_monat: null, break_even_acos: null, tacos: null,
    puffer_je_tag: null, szenarien: [], hinweise: [], grund,
  };
}

/**
 * Was kostet mehr Werbebudget an Liquidität, und ab wann trägt es sich?
 *
 * `werbung_je_tag` und `median_tage` kommen aus der Messung, `db` aus dem
 * letzten abgerechneten Monat. Fehlt eines davon, wird der Teil weggelassen
 * statt geschätzt.
 */
export function werbeSzenarien(
  werbung_je_tag: number | null,
  median_tage: number | null,
  db: DbEingabe | null,
  stufen: number[] = STUFEN,
): WerbeSimulation {
  const jeTag = werbung_je_tag === null ? null : Math.abs(werbung_je_tag);

  if (median_tage === null) {
    return leer(
      "Ohne gemessenen Geldlauf lässt sich nicht sagen, wie lange eine "
      + "Budgeterhöhung Kapital bindet. Dafür braucht es Bestellungen mit "
      + "zugehöriger Abrechnung.",
      jeTag, null,
    );
  }

  const hinweise: string[] = [];

  // --- Deckungsbeitrag ----------------------------------------------------
  let dbQuote: number | null = null;
  let puffer: number | null = null;
  let tacos: number | null = null;

  if (db && db.netto_umsatz > 0 && db.tage_im_monat > 0) {
    dbQuote = Math.round((db.db_vor_werbung / db.netto_umsatz) * 10000) / 10000;
    tacos = Math.round((Math.abs(db.werbung) / db.netto_umsatz) * 10000) / 10000;
    // Was vom Deckungsbeitrag nach der heutigen Werbung übrig bleibt, verteilt
    // auf die Tage des Monats. Bei gleichem Umsatz ist das die Grenze, an der
    // das Monatsergebnis auf null fällt.
    const rest = db.db_vor_werbung - Math.abs(db.werbung);
    puffer = r2(rest / db.tage_im_monat);
    if (puffer <= 0) {
      hinweise.push(
        "Das Monatsergebnis ist schon ohne Erhöhung bei null oder darunter. "
        + "Mehr Budget verschiebt hier nichts, es beschleunigt nur.",
      );
    }
  } else {
    hinweise.push(
      "Kein abgerechneter Monat für den Deckungsbeitrag — die Liquiditätswirkung "
      + "unten steht trotzdem, sie hängt nicht am Deckungsbeitrag. Was fehlt, ist "
      + "die Aussage, ab welchem ACOS sich die Erhöhung trägt.",
    );
  }

  // --- Szenarien ----------------------------------------------------------
  const szenarien: WerbeSzenario[] = stufen.map((delta) => ({
    delta_je_tag: delta,
    budget_je_tag: jeTag === null ? null : r2(jeTag + delta),
    // Der Kern: jeder Euro mehr am Tag ist `median_tage` lang unterwegs.
    gebunden_zusaetzlich: r2(delta * median_tage),
    gebunden_gesamt: jeTag === null ? null : r2((jeTag + delta) * median_tage),
    // Damit sich ein Euro Werbung trägt, muss er so viel Nettoumsatz bringen,
    // dass dessen Deckungsbeitrag ihn deckt: U * db = delta.
    noetiger_mehrumsatz_je_tag: dbQuote === null || dbQuote <= 0
      ? null
      : r2(delta / dbQuote),
  }));

  hinweise.push(
    `Gebunden heißt: dauerhaft. Das Geld kommt nach ${median_tage} Tagen zurück, `
    + "aber am selben Tag geht die nächste Rechnung raus — der Sockel bleibt "
    + "stehen, solange das Budget steht.",
  );

  if (dbQuote !== null) {
    hinweise.push(
      "Ob mehr Budget mehr Umsatz bringt, steht hier bewusst nicht: das weiß "
      + "vorher niemand. Die Zahlen sagen nur, was die Erhöhung mindestens "
      + "bringen muss.",
    );
  }

  return {
    je_tag_aktuell: jeTag === null ? null : r2(jeTag),
    median_tage,
    db_quote: dbQuote,
    db_monat: db?.monat ?? null,
    break_even_acos: dbQuote,
    tacos,
    puffer_je_tag: puffer,
    szenarien,
    hinweise,
    grund: null,
  };
}

/** Tage im Monat "YYYY-MM". */
export function tageImMonat(monat: string): number {
  const j = Number(monat.slice(0, 4));
  const m = Number(monat.slice(5, 7));
  if (!Number.isFinite(j) || !Number.isFinite(m)) return 30;
  return new Date(Date.UTC(j, m, 0)).getUTCDate();
}

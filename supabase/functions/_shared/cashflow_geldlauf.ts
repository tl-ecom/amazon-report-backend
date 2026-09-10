// cashflow_geldlauf.ts — wie lange dauert es vom Verkauf bis zum Geld?
//
// Amazon gibt Guthaben bei vielen Konten erst sieben Tage nach der ZUSTELLUNG
// frei ("DD+7"), nicht nach der Bestellung. Das verlängert den Geldlauf weit
// über die Abrechnungsperiode hinaus, und es taucht in keinem Kontoauszug als
// Posten auf — es äußert sich nur darin, dass Umsätze in eine spätere
// Abrechnung fallen.
//
// An Vanejas Daten gemessen (5.400 Bestellungen): Median 18 Tage von der
// Bestellung bis zur Auszahlung, früheste Eingänge nach 11. Ohne Sperre müsste
// eine Bestellung kurz vor Periodenende nach zwei bis drei Tagen ausgezahlt
// sein — solche Fälle gibt es nicht. Das ist der Nachweis, und er ist je Konto
// verschieden: ein junges Konto liegt anders als ein etabliertes.
//
// Wozu das gut ist: Der Kalender musste die Auszahlungsbeträge bisher aus dem
// Periodendurchschnitt schätzen. Mit der gemessenen Verteilung lässt sich
// stattdessen RECHNEN, wann das Geld aus den noch offenen Bestellungen kommt.

function r2(n: number): number { return Math.round(n * 100) / 100; }

const TAG = 86400000;

// --- Auszahlungsquote -------------------------------------------------------

export interface QuoteZeile {
  monat: string;
  umsatz_brutto_cents: number;
  gebuehren_cents: number;
  werbung_cents: number;
  abdeckung: number;
}

/**
 * Ab dieser Abrechnungsquote taugt ein Monat als Grundlage. Darunter fehlen zu
 * viele Gebühren, und die Quote fällt zu günstig aus: Vanejas September stand
 * bei 86 %, weil dort noch gar keine Gebühren gebucht waren.
 */
export const ABDECKUNG_MIN = 0.8;

export interface Auszahlungsquote {
  quote: number | null;
  monat: string | null;
  abdeckung: number | null;
  grund: string;
}

/**
 * Welcher Anteil des Bruttoumsatzes kommt als Auszahlung an?
 *
 * Aus den POSTEN gerechnet (Umsatz minus Gebühren minus Werbung), nicht aus der
 * Summe der Auszahlungen. Der erste Versuch tat das und kam auf 33 % statt 47 %
 * — zu viele bewegliche Teile: Auszahlungen zählen nur die Hauptreihe, das
 * Umsatzfenster war anders geschnitten, Abzüge aus früheren Perioden liefen mit.
 *
 * Genommen wird der JÜNGSTE hinreichend abgerechnete Monat, nicht der
 * Durchschnitt: Werbebudget und Sortiment ändern sich, und ein halbes Jahr alter
 * Mittelwert beschreibt das heutige Geschäft nicht mehr.
 */
export function auszahlungsquote(zeilen: QuoteZeile[]): Auszahlungsquote {
  const brauchbar = zeilen
    .filter((z) => z.abdeckung >= ABDECKUNG_MIN && z.umsatz_brutto_cents > 0)
    .sort((a, b) => b.monat.localeCompare(a.monat));

  if (brauchbar.length === 0) {
    return {
      quote: null, monat: null, abdeckung: null,
      grund: "Kein Monat ist weit genug abgerechnet, um eine Auszahlungsquote zu "
        + "messen. Ohne sie wird der erwartete Zufluss nicht geschätzt.",
    };
  }

  const m = brauchbar[0];
  const brutto = m.umsatz_brutto_cents;
  // Gebühren kommen negativ, Werbung positiv aus der Datenbank.
  const quote = (brutto + m.gebuehren_cents - m.werbung_cents) / brutto;
  return {
    quote: Math.round(quote * 10000) / 10000,
    monat: m.monat,
    abdeckung: m.abdeckung,
    grund: `Aus ${m.monat} gerechnet: Bruttoumsatz minus Amazon-Gebühren minus `
      + `Werbung, geteilt durch den Bruttoumsatz. Der Monat ist zu `
      + `${Math.round(m.abdeckung * 100)} % abgerechnet.`,
  };
}

// --- Geldlauf ---------------------------------------------------------------

export interface VerteilungZeile { tage: number; bestellungen: number }

export interface GeldlaufMuster {
  median_tage: number | null;
  frueheste_tage: number | null;
  p90_tage: number | null;
  belege: number;
  /** Anteil der Bestellungen je Laufzeit — die Grundlage der Prognose. */
  anteile: Array<{ tage: number; anteil: number }>;
  /**
   * Deutet die Verteilung auf eine Freigabesperre (DD+7)?
   * Ohne Sperre müssten Bestellungen kurz vor Periodenende nach wenigen Tagen
   * ausgezahlt sein. Fehlen solche Fälle ganz, wird das Geld zurückgehalten.
   */
  sperre_erkennbar: boolean;
}

/** Ab dieser frühesten Laufzeit ist eine Freigabesperre die einzige Erklärung. */
const SPERRE_AB_TAGEN = 8;

export function geldlaufMuster(zeilen: VerteilungZeile[]): GeldlaufMuster {
  const sortiert = zeilen.slice().sort((a, b) => a.tage - b.tage);
  const gesamt = sortiert.reduce((s, z) => s + z.bestellungen, 0);
  if (gesamt === 0) {
    return {
      median_tage: null, frueheste_tage: null, p90_tage: null,
      belege: 0, anteile: [], sperre_erkennbar: false,
    };
  }

  const quantil = (q: number): number => {
    let summe = 0;
    for (const z of sortiert) {
      summe += z.bestellungen;
      if (summe >= gesamt * q) return z.tage;
    }
    return sortiert[sortiert.length - 1].tage;
  };

  const frueheste = sortiert[0].tage;
  return {
    median_tage: quantil(0.5),
    frueheste_tage: frueheste,
    p90_tage: quantil(0.9),
    belege: gesamt,
    anteile: sortiert.map((z) => ({
      tage: z.tage,
      anteil: Math.round((z.bestellungen / gesamt) * 10000) / 10000,
    })),
    sperre_erkennbar: frueheste >= SPERRE_AB_TAGEN,
  };
}

// --- Erwartete Zuflüsse -----------------------------------------------------

export interface OffenZeile { am: string; brutto_cents: number }

/**
 * Wann kommt das Geld aus den noch nicht abgerechneten Bestellungen?
 *
 * Jede offene Bestellung wird über die gemessene Verteilung ausgebreitet: Wenn
 * 12 % der Bestellungen 16 Tage brauchen, fallen 12 % ihres Betrags auf Tag+16.
 * Das nutzt die volle gemessene Information statt nur den Median — und der
 * Median allein würde alles auf einen Tag stapeln, den es so nie gibt.
 *
 * Der Betrag ist BRUTTO mal Auszahlungsquote: was Amazon einbehält (Gebühren,
 * Werbung), kommt gar nicht erst an.
 */
export function erwarteteZufluesse(
  offen: OffenZeile[], muster: GeldlaufMuster, quote: number | null,
): Array<{ am: string; betrag: number }> {
  if (quote === null || muster.anteile.length === 0) return [];

  const jeTag = new Map<string, number>();
  for (const o of offen) {
    const basis = ((Number(o.brutto_cents) || 0) / 100) * quote;
    if (basis === 0) continue;
    const start = Date.parse(`${o.am}T00:00:00Z`);
    if (!Number.isFinite(start)) continue;
    for (const a of muster.anteile) {
      const am = new Date(start + a.tage * TAG).toISOString().slice(0, 10);
      jeTag.set(am, (jeTag.get(am) ?? 0) + basis * a.anteil);
    }
  }

  return [...jeTag.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([am, betrag]) => ({ am, betrag: r2(betrag) }));
}

/**
 * Bündelt die erwarteten Tagesbeträge auf die tatsächlichen Auszahlungstermine.
 *
 * Geld kommt nicht täglich, sondern zum Termin. Alles, was seit dem letzten
 * Termin fällig geworden ist, landet auf dem nächsten.
 */
export function aufTermine(
  zufluesse: Array<{ am: string; betrag: number }>, termine: string[],
): Map<string, number> {
  const sortiert = termine.slice().sort();
  const summe = new Map<string, number>();
  for (const z of zufluesse) {
    const ziel = sortiert.find((t) => t >= z.am);
    if (!ziel) continue; // faellt hinter das Fenster
    summe.set(ziel, r2((summe.get(ziel) ?? 0) + z.betrag));
  }
  return summe;
}

// --- Vorfinanzierung --------------------------------------------------------

export interface Vorfinanzierung {
  tage: number | null;
  je_tag: number | null;
  sockel: number | null;
  /** Was eine Budgeterhöhung um 100 € je Tag zusätzlich bindet. */
  je_100_euro_mehr: number | null;
}

/**
 * Wie viel Geld ist dauerhaft gebunden, weil die Werbung sofort abfließt und
 * der Umsatz erst Wochen später ankommt?
 *
 * Das ist der Punkt, der in der Gewinnrechnung nie auftaucht: Wer den Werbe-
 * Spend erhöht, braucht sofort mehr Kapital, und der Rückfluss kommt erst nach
 * dem gemessenen Geldlauf. Der Sockel wächst mit, er verschwindet nicht wieder.
 */
export function vorfinanzierung(
  median_tage: number | null, werbung_je_tag: number | null,
): Vorfinanzierung {
  if (median_tage === null || werbung_je_tag === null) {
    return { tage: null, je_tag: null, sockel: null, je_100_euro_mehr: null };
  }
  const proTag = Math.abs(werbung_je_tag);
  return {
    tage: median_tage,
    je_tag: r2(proTag),
    sockel: r2(proTag * median_tage),
    je_100_euro_mehr: r2(100 * median_tage),
  };
}

// --- Forderung an Amazon ----------------------------------------------------
//
// Was Amazon dem Verkäufer gerade schuldet: verkauft, aber noch nicht
// ausgezahlt. In keiner Amazon-Ansicht steht diese Zahl — der Kontostand im
// Seller Central zeigt nur die laufende Abrechnungsperiode, nicht das Geld, das
// wegen der Freigabesperre noch hinter der Zustellung hängt.
//
// Gerechnet wird NETTO: der Bruttoumsatz der offenen Bestellungen mal der
// gemessenen Auszahlungsquote. Brutto wäre die falsche Zahl — Gebühren, Werbung
// und Umsatzsteuer gehen ab, bevor irgendetwas fliesst. Bei Vaneja sind das
// rund 53 % des Bruttoumsatzes, die gar nicht erst ankommen.

export interface Forderung {
  /** Erwarteter Zufluss aus allem, was verkauft und noch nicht abgerechnet ist. */
  betrag: number | null;
  /** Derselbe Bestand brutto — was die Kunden bezahlt haben. */
  brutto: number | null;
  /** Auszahlungsquote, mit der gerechnet wurde. */
  quote: number | null;
  /** Erster und letzter Tag, an dem daraus noch Geld erwartet wird. */
  ab: string | null;
  bis: string | null;
  /** Davon innerhalb der nächsten `fenster_tage` Tage. */
  im_fenster: number | null;
  fenster_tage: number;
  grund: string | null;
}

export function forderungAnAmazon(
  zufluesse: Array<{ am: string; betrag: number }>,
  brutto: number | null,
  quote: number | null,
  fenster_tage = 30,
  heute = new Date(),
): Forderung {
  const leer = (grund: string): Forderung => ({
    betrag: null, brutto, quote, ab: null, bis: null,
    im_fenster: null, fenster_tage, grund,
  });

  if (quote === null) {
    return leer(
      "Ohne gemessene Auszahlungsquote lässt sich aus dem offenen Umsatz kein "
      + "Zufluss ableiten. Der Bruttobetrag steht daneben — er ist NICHT die "
      + "Forderung, davon gehen Gebühren, Werbung und Umsatzsteuer ab.",
    );
  }
  if (zufluesse.length === 0) {
    return leer(
      "Es sind keine unabgerechneten Bestellungen offen, aus denen noch Geld "
      + "erwartet wird.",
    );
  }

  const heuteIso = new Date(heute).toISOString().slice(0, 10);
  const grenze = new Date(new Date(heute).getTime() + fenster_tage * TAG)
    .toISOString().slice(0, 10);

  // Ein Zufluss, der rechnerisch in der Vergangenheit liegt, ist trotzdem noch
  // nicht da — sonst waere die Bestellung abgerechnet. Er bleibt Forderung.
  const summe = zufluesse.reduce((s, z) => s + z.betrag, 0);
  const imFenster = zufluesse
    .filter((z) => z.am <= grenze)
    .reduce((s, z) => s + z.betrag, 0);

  const tage = zufluesse.map((z) => z.am).sort();
  return {
    betrag: r2(summe),
    brutto,
    quote,
    ab: tage[0] < heuteIso ? heuteIso : tage[0],
    bis: tage[tage.length - 1],
    im_fenster: r2(imFenster),
    fenster_tage,
    grund: null,
  };
}

// ust_faktor.ts — Wieviel Umsatzsteuer steckt in den gebuchten Amazon-Gebühren?
//
// Warum überhaupt messen statt annehmen:
// Amazon bucht Gebühren als EINEN Betrag, ohne die Steuer auszuweisen (nachgewiesen
// im Abrechnungsbericht: `ItemPrice` hat eine eigene Tax-Zeile, `ItemFees` nicht).
// Ein fest verdrahtetes /1,19 wäre für einen regelbesteuerten deutschen Verkäufer
// richtig und für andere falsch:
//   * Reverse Charge (Rechnung aus Luxemburg ohne USt.) -> Faktor 1,00
//   * Kleinunternehmer: zahlt die USt., bekommt sie NICHT erstattet -> Faktor 1,00
//   * andere Länder: FR 20 %, IT 22 %
// Bei einem Reverse-Charge-Konto würde /1,19 die Gebühren um 19 % kleinrechnen und
// eine Marge zeigen, die es nicht gibt. Eine falsche Entwarnung ist schlimmer als
// eine bekannte Lücke.
//
// Gemessen wird an Paaren derselben Gebühr aus zwei unabhängigen Quellen:
//   brutto = was Amazon GEBUCHT hat        (Abrechnungsbericht, je Position)
//   netto  = was Amazon ERWARTET           (Gebührenvorschau-Report, je SKU)
// Der Vorschau-Wert ist die richtige Netto-Basis auch für Sonderfälle: bei einem
// Niedrigpreisversand-Artikel nennt er den Niedrigpreistarif, nicht den Standard.
//
// Dieses Modul ist rein und ohne DB-Zugriff, damit die Regeln testbar bleiben.

export interface Paar {
  sku: string;
  /** Gebuchter Betrag je Stück in Cent, positiv. */
  brutto_cents: number;
  /** Von Amazon erwartete Gebühr je Stück in Cent, positiv. */
  netto_cents: number;
}

export interface FaktorErgebnis {
  /** Gemessener Faktor (brutto/netto), auf 3 Stellen. null = nicht bestimmbar. */
  faktor: number | null;
  /**
   * Wert, der zur Übernahme vorgeschlagen wird. Liegt die Messung dicht an einem
   * gesetzlichen Satz, ist DAS der Vorschlag — ein Steuersatz ist eine exakte
   * Zahl, keine Messgröße. 1,1905 gemessen heißt 19 %, nicht 19,05 %.
   */
  vorschlag: number | null;
  /** Enthaltener Steuersatz in Prozent, gerundet. null wenn kein Faktor. */
  prozent: number | null;
  /** Name des nächstliegenden üblichen Satzes, sofern die Messung dazu passt. */
  entspricht: string | null;
  paare: number;
  produkte: number;
  spanne: [number, number] | null;
  /** Anteil der PRODUKTE, die eng am Median liegen (0..1). */
  einigkeit: number | null;
  /** Produkte, die deutlich abweichen — die sollte man sich ansehen. */
  ausreisser: Array<{ sku: string; faktor: number }>;
  brauchbar: boolean;
  begruendung: string;
}

/** Mindestens so viele verschiedene Produkte, sonst ist es kein Muster. */
export const MIN_PRODUKTE = 3;
/** Mindestens so viele Einzelpaare. */
export const MIN_PAARE = 5;
/** Wie weit ein Paar vom Median abweichen darf, um als „einig" zu gelten. */
export const TOLERANZ = 0.015;
/** So viele Paare müssen innerhalb der Toleranz liegen. */
export const MIN_EINIGKEIT = 0.8;
/** Ausserhalb dieser Grenzen misst man nicht Steuer, sondern einen anderen Fehler. */
export const FAKTOR_MIN = 0.97;
export const FAKTOR_MAX = 1.30;
/** Bis hierhin gilt „praktisch kein Aufschlag" — z.B. Reverse Charge. */
export const OHNE_UST_BIS = 1.005;

/** Übliche Sätze, nur zur Benennung des Messwerts. */
const BEKANNTE_SAETZE: Array<{ faktor: number; name: string }> = [
  { faktor: 1.00, name: "keine Umsatzsteuer (z. B. Reverse Charge)" },
  { faktor: 1.19, name: "19 % (Deutschland)" },
  { faktor: 1.20, name: "20 % (Frankreich, Österreich)" },
  { faktor: 1.21, name: "21 % (Niederlande, Spanien, Belgien)" },
  { faktor: 1.22, name: "22 % (Italien)" },
  { faktor: 1.23, name: "23 % (Polen)" },
  { faktor: 1.25, name: "25 % (Schweden)" },
];

function median(werte: number[]): number {
  const s = [...werte].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Findet den gesetzlichen Satz, zu dem die Messung passt. */
function passenderSatz(faktor: number): { faktor: number; name: string } | null {
  for (const b of BEKANNTE_SAETZE) {
    if (Math.abs(faktor - b.faktor) <= 0.005) return b;
  }
  return null;
}

const LEER: Omit<FaktorErgebnis, "paare" | "produkte" | "begruendung"> = {
  faktor: null, vorschlag: null, prozent: null, entspricht: null,
  spanne: null, einigkeit: null, ausreisser: [], brauchbar: false,
};

/**
 * Misst den Steuerfaktor. Liefert lieber „nicht bestimmbar" als eine Zahl,
 * der man nicht trauen kann — auf diesem Faktor steht später jede Marge.
 *
 * Gezählt wird JE PRODUKT, nicht je Buchung: Bei Vaneja stellte ein einziger
 * Artikel 173 von 872 Buchungen und hatte einen eigenen Aufschlag (1,239 statt
 * 1,190). Buchungsgewichtet hätte dieser eine Artikel die Messung gekippt.
 * Produktgewichtet ist er das, was er ist — ein Ausreisser unter fünfzehn.
 */
export function messeUstFaktor(paare: Paar[]): FaktorErgebnis {
  const gueltig = paare.filter(
    (p) => Number.isFinite(p.brutto_cents) && Number.isFinite(p.netto_cents) &&
      p.brutto_cents > 0 && p.netto_cents > 0,
  );

  // Erst je Produkt zusammenfassen (Median, damit einzelne Buchungen nicht ziehen).
  const jeSku = new Map<string, number[]>();
  for (const p of gueltig) {
    const liste = jeSku.get(p.sku) ?? [];
    liste.push(p.brutto_cents / p.netto_cents);
    jeSku.set(p.sku, liste);
  }
  const proProdukt = [...jeSku.entries()]
    .map(([sku, qs]) => ({ sku, faktor: median(qs) }))
    .sort((a, b) => a.faktor - b.faktor);
  const produkte = proProdukt.length;

  if (gueltig.length < MIN_PAARE || produkte < MIN_PRODUKTE) {
    return {
      ...LEER, paare: gueltig.length, produkte,
      begruendung: `Zu wenig Vergleichsdaten: ${gueltig.length} Buchung(en) über ${produkte} Produkt(e). ` +
        `Nötig sind ${MIN_PAARE} Buchungen über ${MIN_PRODUKTE} Produkte.`,
    };
  }

  const mitte = median(proProdukt.map((p) => p.faktor));
  const nah = proProdukt.filter((p) => Math.abs(p.faktor - mitte) <= TOLERANZ * mitte);
  const einigkeit = nah.length / produkte;
  const spanne: [number, number] = [
    Math.round(proProdukt[0].faktor * 1000) / 1000,
    Math.round(proProdukt[produkte - 1].faktor * 1000) / 1000,
  ];
  const ausreisser = proProdukt
    .filter((p) => Math.abs(p.faktor - mitte) > TOLERANZ * mitte)
    .map((p) => ({ sku: p.sku, faktor: Math.round(p.faktor * 1000) / 1000 }))
    .slice(0, 10);
  const basis = {
    paare: gueltig.length, produkte, spanne,
    einigkeit: Math.round(einigkeit * 100) / 100, ausreisser,
  };

  if (mitte < FAKTOR_MIN || mitte > FAKTOR_MAX) {
    return {
      ...LEER, ...basis,
      begruendung: `Gemessen wurde ${mitte.toFixed(3)} — das liegt ausserhalb dessen, was ein Steuersatz ` +
        `erklären kann. Vermutlich passen gebuchte und erwartete Gebühr aus einem anderen Grund nicht zusammen.`,
    };
  }
  if (einigkeit < MIN_EINIGKEIT) {
    return {
      ...LEER, ...basis,
      begruendung: `Die Produkte streuen zu stark (${spanne[0]} bis ${spanne[1]}, nur ` +
        `${Math.round(einigkeit * 100)} % nah beieinander). Ein einzelner Faktor wäre geraten.`,
    };
  }

  const faktor = Math.round(mitte * 1000) / 1000;
  const satz = passenderSatz(faktor);
  const vorschlag = satz ? satz.faktor : faktor;
  const prozent = Math.round((vorschlag - 1) * 1000) / 10;
  return {
    ...basis,
    faktor,
    vorschlag,
    prozent,
    entspricht: satz ? satz.name : null,
    brauchbar: true,
    begruendung: vorschlag <= OHNE_UST_BIS
      ? `Gemessen an ${gueltig.length} Buchungen über ${produkte} Produkte: ${faktor.toFixed(3)} — ` +
        `in den Gebühren steckt praktisch keine Umsatzsteuer.`
      : `Gemessen an ${gueltig.length} Buchungen über ${produkte} Produkte: ${faktor.toFixed(3)}` +
        `${satz ? ` — das ist ${satz.name}` : ""}. ` +
        `${nah.length} von ${produkte} Produkten liegen eng beieinander (${spanne[0]} bis ${spanne[1]}).`,
  };
}

/**
 * Rechnet einen gebuchten Bruttobetrag auf netto. Ohne bestätigten Faktor bleibt
 * der Betrag UNVERÄNDERT — nie stillschweigend umrechnen.
 */
export function nettoGebuehr(brutto_cents: number, faktor: number | null): number {
  if (faktor === null || !Number.isFinite(faktor) || faktor < FAKTOR_MIN || faktor > FAKTOR_MAX) {
    return brutto_cents;
  }
  return Math.round(brutto_cents / faktor);
}

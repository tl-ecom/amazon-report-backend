// gebuehrenaenderung.ts — Gebührenänderungen durchrechnen, BEVOR sie greifen.
//
// Amazon kündigt neue Versandgebühren mit Vorlauf an. Die Frage des Coaches ist
// dann nicht „was kostet das insgesamt", sondern: WELCHE Produkte fallen dadurch
// unter ihre Zielmarge, und was müsste der Preis tun, damit sie es nicht tun.
//
// Die Mechanik:
//   * Die Rate Card ist in `fee_schedule` bereits versioniert (`gueltig_ab`).
//     Eine angekündigte Änderung ist also einfach ein Import mit einem Datum in
//     der Zukunft — kein neues Datenmodell, kein Sonderweg.
//   * Gerechnet wird dieselbe Kaskade wie im laufenden Betrieb (Tarif → Klasse →
//     Gewichtsstufe, Treibstoffaufschlag), einmal gegen die alte und einmal gegen
//     die neue Tabelle. Dieselben geprüften Funktionen, zwei Eingaben.
//
// Vier Dinge, die hier bewusst NICHT passieren:
//
//   1. Keine erfundene Zielmarge. Fehlt sie, ist das Ergebnis „kein Ziel
//      hinterlegt" — und der Coach weiß, was zu tun ist. Eine Hausnummer wie
//      „20 % sind üblich" wäre die eine Zahl, an der später jede Maßnahme hängt.
//   2. Werbekosten fehlen (Ads-API). Deshalb ist nur EINE Richtung beweisbar:
//      Wer schon VOR Werbung unter der Zielmarge liegt, liegt auch danach
//      darunter. Umgekehrt gilt das nicht — „hält die Marge" wird deshalb als
//      unbestätigt ausgewiesen. Der Abstand zur Untergrenze ist genau der
//      Werbeanteil, den das Produkt noch verträgt; das ist die ehrliche Aussage.
//   3. Keine Mengenprognose. Hochgerechnet wird der bisherige Absatz, nicht ein
//      erhoffter. Eine Gebührenänderung ändert die Gebühr, nicht die Nachfrage.
//   4. Keine Preisempfehlung. Berechnet wird der Preis, der die Zielmarge
//      rechnerisch hält — ob der Markt ihn trägt, weiß diese Rechnung nicht.

import {
  TREIBSTOFF_AUFSCHLAG,
  abrechnungsgewicht,
  gebuehrFuer,
  klasseFuerMasse,
  niedrigpreisGrenze,
  waehleTarif,
  type Klasse,
  type Preisgrenze,
  type Produkt,
  type Tarif,
} from "./groessenklassen.ts";
import { effektiverKorridor, type KorridorWert } from "./strategie_wizard.ts";

/** Abweichung zwischen Tabelle und gebuchter Gebühr, ab der die Prognose unsicher ist. */
export const TABELLE_ABWEICHUNG = 0.05;

export type MargenStatus =
  /** Liegt nach der Änderung unter der Zielmarge — und zwar beweisbar. */
  | "unter_ziel"
  /** Hält die Zielmarge, aber ohne Werbekosten gerechnet. Nicht bestätigt. */
  | "im_ziel_ohne_werbung"
  /** Für diese ASIN ist keine Zielmarge hinterlegt. */
  | "kein_ziel"
  /** Ohne Einkaufspreis gibt es keine Marge — nur den Gebührenunterschied. */
  | "kein_ek"
  /** Grunddaten fehlen (Maße, Klasse, Gebühren, Umsatz). */
  | "nicht_bewertbar";

export type ZielQuelle = "asin" | "rolle" | "firma" | "leer";

export interface Zielmarge {
  prozent: number | null;
  quelle: ZielQuelle;
  rolle: string | null;
}

/** Ergebnis je SKU: was die neue Tabelle an dieser Verpackung ändert. */
export interface GebuehrDelta {
  sku: string;
  asin: string | null;
  produktname: string | null;
  tarif_alt: Tarif | null;
  tarif_neu: Tarif | null;
  klasse: string | null;
  /** Nur gesetzt, wenn die neue Tabelle das Produkt anders einordnet. */
  klasse_neu: string | null;
  klassenwechsel: boolean;
  gebuehr_alt: number | null;
  gebuehr_neu: number | null;
  /** Plus = teurer. Enthält den Treibstoffaufschlag. */
  delta_je_stueck: number | null;
  einheiten: number;
  fenster_tage: number;
  delta_jahr: number | null;
  hochgerechnet: boolean;
  /** Passt die ALTE Tabelle zu dem, was Amazon heute abrechnet? */
  tabelle_passt: boolean | null;
  grund: string | null;
}

/** Gemessene Stückrechnung einer ASIN aus produkt_uebersicht (Fenster identisch). */
export interface AsinErtrag {
  asin: string;
  produktname: string | null;
  einheiten: number;
  /** Nettoumsatz im Fenster (Umsatzsteuer bereits heraus). */
  umsatz_netto: number;
  wareneinsatz: number | null;
  /** Alle Gebühren signiert wie gebucht: negativ = Kosten. */
  fba_gebuehr: number | null;
  verkaufsgebuehr: number | null;
  sonstige_gebuehren: number | null;
}

export interface AsinBefund {
  asin: string;
  produktname: string | null;
  rolle: string | null;
  status: MargenStatus;
  skus: number;
  /** SKUs, für die kein Gebührenunterschied bestimmbar war. */
  skus_ohne_wert: number;
  einheiten: number;
  delta_je_stueck: number | null;
  delta_jahr: number | null;
  preis_netto: number | null;
  preis_brutto: number | null;
  marge_jetzt: number | null;
  marge_nachher: number | null;
  zielmarge: number | null;
  zielmarge_quelle: ZielQuelle;
  /** Wie viele Prozentpunkte fehlen zur Zielmarge (nur bei unter_ziel). */
  luecke: number | null;
  /** Wie viel Werbeanteil das Produkt noch verträgt (nur bei im_ziel_ohne_werbung). */
  puffer: number | null;
  noetiger_preis_brutto: number | null;
  preis_erhoehung_brutto: number | null;
  /** Die nötige Erhöhung würde das Produkt aus dem Niedrigpreisversand heben. */
  tarifwechsel_bei_erhoehung: boolean;
  klassenwechsel: boolean;
  tabelle_passt: boolean | null;
  grund: string | null;
}

function nz(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function runde(n: number, stellen = 2): number {
  const f = 10 ** stellen;
  return Math.round(n * f) / f;
}

function leeresDelta(p: Produkt, grund: string): GebuehrDelta {
  return {
    sku: p.sku, asin: p.asin, produktname: p.produktname,
    tarif_alt: null, tarif_neu: null, klasse: p.groessenklasse,
    klasse_neu: null, klassenwechsel: false,
    gebuehr_alt: null, gebuehr_neu: null, delta_je_stueck: null,
    einheiten: p.einheiten, fenster_tage: p.fenster_tage,
    delta_jahr: null, hochgerechnet: false, tabelle_passt: null,
    grund,
  };
}

/**
 * Was die neue Tabelle für EINE SKU ändert.
 *
 * `alt` und `neu` müssen je genau EINE Gültigkeitsperiode enthalten. Zeilen aus
 * zwei Perioden zu mischen ergäbe einen Unterschied, den es nie gab.
 */
export function vergleicheGebuehr(
  p: Produkt, alt: Klasse[], neu: Klasse[], grenzen: Preisgrenze[] = [],
): GebuehrDelta {
  const l = nz(p.laengste_seite_cm), b = nz(p.mittlere_seite_cm), h = nz(p.kuerzeste_seite_cm);
  const stueck = nz(p.gewicht_g);
  if (l === null || b === null || h === null || stueck === null) {
    return leeresDelta(p, "Amazon liefert für dieses Produkt keine vollständigen Maße oder kein Gewicht.");
  }
  if (!p.groessenklasse) return leeresDelta(p, "Amazon nennt keine Größenklasse.");

  // Der Tarif wird für BEIDE Tabellen einzeln bestimmt: Ändert die neue Rate Card
  // die Preisgrenze des Niedrigpreisversands, wechselt ein Produkt den Tarif,
  // ohne dass sich an ihm selbst etwas geändert hat.
  const wahlAlt = waehleTarif(p, alt, grenzen);
  const wahlNeu = waehleTarif(p, neu, grenzen);
  if (wahlAlt.tarif === null) return leeresDelta(p, `Bisherige Tabelle: ${wahlAlt.grund}`);
  if (wahlNeu.tarif === null) return leeresDelta(p, `Neue Tabelle: ${wahlNeu.grund}`);
  const tarifAlt = wahlAlt.tarif, tarifNeu = wahlNeu.tarif;
  const klassenAlt = wahlAlt.klassen, klassenNeu = wahlNeu.klassen;

  const kAlt = klassenAlt.find((k) => k.size_tier === p.groessenklasse);
  if (!kAlt) {
    return leeresDelta(p, `Die Klasse „${p.groessenklasse}" ist in der bisherigen Gebührentabelle nicht hinterlegt.`);
  }
  const versandAlt = abrechnungsgewicht(tarifAlt, stueck, l, b, h);
  const gebAlt = gebuehrFuer(kAlt, versandAlt);
  if (gebAlt === null) {
    return leeresDelta(p, `Für „${p.groessenklasse}" bei ${Math.round(versandAlt)} g ist in der bisherigen Tabelle keine Gebühr hinterlegt.`);
  }

  // Ob die neue Tabelle das Produkt anders EINORDNET, entscheidet der Vergleich
  // der jeweils gemessenen Einstufung — nicht der Vergleich mit Amazons Angabe.
  // Sonst meldete jede Abweichung zwischen Amazons Zuordnung und der Tabelle
  // einen Klassenwechsel, den die neue Karte gar nicht verursacht hat.
  const kanten: [number, number, number] = [l, b, h];
  const gemessenAlt = klasseFuerMasse(kanten, stueck, klassenAlt, kAlt);
  const kNeuGleich = klassenNeu.find((k) => k.size_tier === p.groessenklasse) ?? null;
  const gemessenNeu = klasseFuerMasse(kanten, stueck, klassenNeu, kNeuGleich ?? kAlt);

  const kNeu = kNeuGleich ?? gemessenNeu?.klasse ?? null;
  if (!kNeu) {
    return leeresDelta(p, `Die Klasse „${p.groessenklasse}" fehlt in der neuen Gebührentabelle, und keine andere Klasse passt zu diesen Maßen.`);
  }
  const versandNeu = abrechnungsgewicht(tarifNeu, stueck, l, b, h);
  const gebNeu = gebuehrFuer(kNeu, versandNeu);
  if (gebNeu === null) {
    return leeresDelta(p, `Für „${kNeu.size_tier}" bei ${Math.round(versandNeu)} g ist in der neuen Tabelle keine Gebühr hinterlegt.`);
  }

  const klassenwechsel = gemessenAlt !== null && gemessenNeu !== null &&
    gemessenAlt.klasse.size_tier !== gemessenNeu.klasse.size_tier;

  const alt_eur = runde(gebAlt * TREIBSTOFF_AUFSCHLAG);
  const neu_eur = runde(gebNeu * TREIBSTOFF_AUFSCHLAG);
  const delta = runde(neu_eur - alt_eur);

  // Realitätsanker: Wenn schon die BISHERIGE Tabelle nicht zu dem passt, was
  // Amazon heute abrechnet, ist auch die Prognose nur so gut wie die Tabelle.
  const gemessen = nz(p.fulfilment_cents);
  const tabelle_passt = gemessen === null
    ? null
    : Math.abs(gemessen / 100 - alt_eur) <= TABELLE_ABWEICHUNG * alt_eur;

  const tage = p.fenster_tage > 0 ? p.fenster_tage : 365;
  const jahr = p.einheiten > 0 ? runde(delta * p.einheiten * (365 / tage), 0) : null;

  return {
    sku: p.sku, asin: p.asin, produktname: p.produktname,
    tarif_alt: tarifAlt, tarif_neu: tarifNeu,
    klasse: p.groessenklasse,
    // Bei verschobenen Grenzen zeigt das Feld, wohin die neue Karte das Produkt
    // stellen würde. Gerechnet wird trotzdem mit der Klasse, die Amazon heute
    // zuweist — welche Klasse Amazon künftig vergibt, weiß diese Tabelle nicht.
    klasse_neu: klassenwechsel
      ? (gemessenNeu?.klasse.size_tier ?? null)
      : (kNeu.size_tier === p.groessenklasse ? null : kNeu.size_tier),
    klassenwechsel,
    gebuehr_alt: alt_eur, gebuehr_neu: neu_eur, delta_je_stueck: delta,
    einheiten: p.einheiten, fenster_tage: tage,
    delta_jahr: jahr, hochgerechnet: tage < 365,
    tabelle_passt,
    grund: null,
  };
}

/**
 * Woher die Zielmarge kommt — in dieser Reihenfolge, und immer nachvollziehbar:
 *   1. Korridor dieser ASIN (Override im Strategie-Pfad)
 *   2. Korridor ihrer Rolle
 *   3. Firmenvorgabe (eine Zahl fürs ganze Konto)
 * Nichts davon gesetzt heißt „leer" — nicht „üblich sind ...".
 */
export function zielmargeAus(
  asinOverride: KorridorWert | null,
  rollenDefault: KorridorWert | null,
  firmaProzent: number | null,
  rolle: string | null,
): Zielmarge {
  const eff = effektiverKorridor(asinOverride, rollenDefault);
  if (eff.min !== null) {
    return { prozent: eff.min, quelle: eff.quelle === "override" ? "asin" : "rolle", rolle };
  }
  const firma = nz(firmaProzent);
  if (firma !== null) return { prozent: firma, quelle: "firma", rolle };
  return { prozent: null, quelle: "leer", rolle };
}

/**
 * Welcher Nettopreis hält die Zielmarge?
 *
 *   DB(P) = P − fix − r·P        mit r = Verkaufsgebührenquote auf den Nettopreis
 *   DB(P) ≥ m·P                  mit m = Zielmarge
 *   ⇒ P ≥ fix / (1 − r − m)
 *
 * Die Verkaufsgebühr steigt mit dem Preis mit — wer sie hier vergisst, nennt eine
 * Erhöhung, die die Zielmarge verfehlt. `fix` sind die preisunabhängigen Kosten
 * je Stück (Einkauf, Versandgebühr NEU, sonstige Gebühren).
 *
 * null, wenn der Nenner nicht positiv ist: Dann ist die Zielmarge bei dieser
 * Gebührenquote zu keinem Preis erreichbar, und jede Zahl wäre eine Lüge.
 *
 * Aufgerundet auf den Cent, nicht kaufmännisch gerundet: Abrunden hieße, einen
 * Preis zu nennen, der die Zielmarge um Haaresbreite verfehlt.
 */
export function noetigerNettopreis(
  fix: number, referralQuote: number, zielmargeProzent: number,
): number | null {
  const nenner = 1 - referralQuote - zielmargeProzent / 100;
  if (!(nenner > 0)) return null;
  return Math.ceil((fix / nenner) * 100) / 100;
}

function leererBefund(
  asin: string, name: string | null, rolle: string | null, ziel: Zielmarge, grund: string,
): AsinBefund {
  return {
    asin, produktname: name, rolle, status: "nicht_bewertbar",
    skus: 0, skus_ohne_wert: 0, einheiten: 0,
    delta_je_stueck: null, delta_jahr: null,
    preis_netto: null, preis_brutto: null,
    marge_jetzt: null, marge_nachher: null,
    zielmarge: ziel.prozent, zielmarge_quelle: ziel.quelle,
    luecke: null, puffer: null,
    noetiger_preis_brutto: null, preis_erhoehung_brutto: null,
    tarifwechsel_bei_erhoehung: false,
    klassenwechsel: false, tabelle_passt: null,
    grund,
  };
}

/**
 * Eine ASIN bewerten: Gebührenunterschied (über ihre SKUs gewichtet) gegen die
 * gemessene Stückrechnung und die Zielmarge.
 *
 * `niedrigpreisGrenzeCents` dient nur der Warnung, dass eine nötige Preiserhöhung
 * das Produkt aus dem Niedrigpreisversand heben würde — dann steigt die
 * Versandgebühr zusätzlich, und die Rechnung stimmt nicht mehr.
 */
export function bewerteAsin(
  deltas: GebuehrDelta[],
  ertrag: AsinErtrag | null,
  ziel: Zielmarge,
  opts: { umsatzsteuerProzent: number; niedrigpreisGrenzeCents: number },
): AsinBefund {
  const erste = deltas[0];
  const asin = String(erste?.asin ?? ertrag?.asin ?? "");
  const name = ertrag?.produktname ?? erste?.produktname ?? null;
  const rolle = ziel.rolle;

  const mitWert = deltas.filter((d) => d.delta_je_stueck !== null);
  const ohneWert = deltas.length - mitWert.length;
  const klassenwechsel = mitWert.some((d) => d.klassenwechsel);
  const tabelleWerte = mitWert.map((d) => d.tabelle_passt).filter((x): x is boolean => x !== null);
  const tabelle_passt = tabelleWerte.length === 0 ? null : tabelleWerte.every(Boolean);

  if (mitWert.length === 0) {
    const b = leererBefund(asin, name, rolle, ziel,
      erste?.grund ?? "Für dieses Produkt liegt kein Gebührenunterschied vor.");
    b.skus = deltas.length;
    b.skus_ohne_wert = ohneWert;
    return b;
  }

  // Mehrere SKUs je ASIN: nach verkaufter Menge gewichten. Ohne Absatz zählt
  // jede SKU gleich — ein ungewichteter Mittelwert ist besser als eine willkürlich
  // ausgewählte SKU.
  const mengen = mitWert.reduce((s, d) => s + d.einheiten, 0);
  const deltaStueck = mengen > 0
    ? runde(mitWert.reduce((s, d) => s + d.delta_je_stueck! * d.einheiten, 0) / mengen)
    : runde(mitWert.reduce((s, d) => s + d.delta_je_stueck!, 0) / mitWert.length);
  const deltaJahr = mitWert.some((d) => d.delta_jahr !== null)
    ? runde(mitWert.reduce((s, d) => s + (d.delta_jahr ?? 0), 0), 0)
    : null;

  const basis: AsinBefund = {
    asin, produktname: name, rolle, status: "nicht_bewertbar",
    skus: deltas.length, skus_ohne_wert: ohneWert,
    einheiten: mengen,
    delta_je_stueck: deltaStueck, delta_jahr: deltaJahr,
    preis_netto: null, preis_brutto: null,
    marge_jetzt: null, marge_nachher: null,
    zielmarge: ziel.prozent, zielmarge_quelle: ziel.quelle,
    luecke: null, puffer: null,
    noetiger_preis_brutto: null, preis_erhoehung_brutto: null,
    tarifwechsel_bei_erhoehung: false,
    klassenwechsel, tabelle_passt,
    grund: null,
  };

  if (!ertrag || ertrag.einheiten <= 0 || ertrag.umsatz_netto <= 0) {
    return { ...basis, grund: "Im betrachteten Zeitraum kein Umsatz — ohne ihn gibt es keine Stückrechnung." };
  }
  const stk = ertrag.einheiten;
  const preisNetto = runde(ertrag.umsatz_netto / stk);

  const fba = nz(ertrag.fba_gebuehr);
  const verkauf = nz(ertrag.verkaufsgebuehr);
  const sonstige = nz(ertrag.sonstige_gebuehren);
  if (fba === null || verkauf === null) {
    return {
      ...basis, preis_netto: preisNetto,
      preis_brutto: runde(preisNetto * (1 + opts.umsatzsteuerProzent / 100)),
      grund: "Für dieses Produkt sind die gebuchten Amazon-Gebühren noch nicht zugeordnet.",
    };
  }
  // Gebucht sind sie negativ (Kosten). Ab hier wird mit positiven Kosten gerechnet.
  const fbaStueck = runde(-fba / stk);
  const verkaufStueck = runde(-verkauf / stk);
  const sonstigeStueck = sonstige === null ? 0 : runde(-sonstige / stk);
  const referralQuote = preisNetto > 0 ? verkaufStueck / preisNetto : 0;

  const ust = opts.umsatzsteuerProzent;
  const preisBrutto = runde(preisNetto * (1 + ust / 100));
  const ek = ertrag.wareneinsatz === null ? null : runde(ertrag.wareneinsatz / stk);

  if (ek === null) {
    return {
      ...basis, status: "kein_ek",
      preis_netto: preisNetto, preis_brutto: preisBrutto,
      grund: "Ohne Einkaufspreis lässt sich keine Marge rechnen — der Gebührenunterschied steht trotzdem.",
    };
  }

  // Marge VOR Werbung. Der Name ist Programm: Werbekosten fehlen noch.
  const dbJetzt = runde(preisNetto - ek - fbaStueck - verkaufStueck - sonstigeStueck);
  const dbNachher = runde(dbJetzt - deltaStueck);
  const margeJetzt = runde((dbJetzt / preisNetto) * 100, 1);
  const margeNachher = runde((dbNachher / preisNetto) * 100, 1);

  const mit = {
    ...basis,
    preis_netto: preisNetto, preis_brutto: preisBrutto,
    marge_jetzt: margeJetzt, marge_nachher: margeNachher,
  };

  if (ziel.prozent === null) {
    return {
      ...mit, status: "kein_ziel",
      grund: rolle
        ? `Für die Rolle „${rolle}" ist keine Untergrenze hinterlegt.`
        : "Für dieses Produkt ist keine Zielmarge hinterlegt.",
    };
  }

  const fix = runde(ek + fbaStueck + deltaStueck + sonstigeStueck);
  const noetigNetto = noetigerNettopreis(fix, referralQuote, ziel.prozent);
  const noetigBrutto = noetigNetto === null ? null : runde(noetigNetto * (1 + ust / 100));
  const erhoehung = noetigBrutto === null ? null : runde(Math.max(0, noetigBrutto - preisBrutto));
  // Eine Erhöhung über die Preisgrenze hinaus wechselt den Tarif — dann gilt die
  // Standardtabelle, und die hier gerechnete Versandgebühr stimmt nicht mehr.
  const grenze = opts.niedrigpreisGrenzeCents / 100;
  const tarifwechsel = preisBrutto < grenze && noetigBrutto !== null && noetigBrutto >= grenze;

  if (margeNachher < ziel.prozent) {
    return {
      ...mit, status: "unter_ziel",
      luecke: runde(ziel.prozent - margeNachher, 1),
      noetiger_preis_brutto: noetigBrutto,
      preis_erhoehung_brutto: erhoehung,
      tarifwechsel_bei_erhoehung: tarifwechsel,
      grund: noetigBrutto === null
        ? "Die Zielmarge ist bei dieser Verkaufsgebührenquote zu keinem Preis erreichbar."
        : null,
    };
  }
  return {
    ...mit, status: "im_ziel_ohne_werbung",
    puffer: runde(margeNachher - ziel.prozent, 1),
  };
}

export interface SimulationEingabe {
  produkte: Produkt[];
  klassenAlt: Klasse[];
  klassenNeu: Klasse[];
  ertraege: AsinErtrag[];
  /** Zielmarge je ASIN — vom Aufrufer aus Korridor/Rolle/Firma aufgelöst. */
  ziele: Map<string, Zielmarge>;
  umsatzsteuerProzent: number;
  /**
   * Preisgrenzen des Niedrigpreisversands je Produktgruppe. Leer = die Vorgabe
   * gilt für alle; dann rechnet die Vorschau wie vor der Kategorieunterscheidung.
   */
  grenzen?: Preisgrenze[];
}

/**
 * Der ganze Lauf. Reihenfolge der Ausgabe = Reihenfolge der Dringlichkeit:
 * erst wer unter die Zielmarge fällt (nach Jahresbetrag), dann der Rest.
 */
export function simuliere(e: SimulationEingabe) {
  const deltas = e.produkte.map((p) =>
    vergleicheGebuehr(p, e.klassenAlt, e.klassenNeu, e.grenzen ?? [])
  );

  const proAsin = new Map<string, GebuehrDelta[]>();
  for (const d of deltas) {
    const key = d.asin ?? `sku:${d.sku}`;
    (proAsin.get(key) ?? proAsin.set(key, []).get(key)!).push(d);
  }
  const ertragVon = new Map(e.ertraege.map((x) => [x.asin, x]));
  const grenze = niedrigpreisGrenze(e.klassenNeu);

  const befunde = [...proAsin.entries()].map(([key, ds]) =>
    bewerteAsin(ds, ertragVon.get(key) ?? null, e.ziele.get(key) ?? { prozent: null, quelle: "leer", rolle: null }, {
      umsatzsteuerProzent: e.umsatzsteuerProzent,
      niedrigpreisGrenzeCents: grenze,
    })
  );

  const nachBetrag = (a: AsinBefund, b: AsinBefund) => (b.delta_jahr ?? 0) - (a.delta_jahr ?? 0);
  const unterZiel = befunde.filter((b) => b.status === "unter_ziel").sort(nachBetrag);

  // Zwei verschiedene Fragen, deshalb zwei getrennte Zähler:
  //   * Ist der GEBÜHRENUNTERSCHIED bekannt? (Maße, Klasse, Tabelle)
  //   * Ist die MARGE bewertbar? (Umsatz, Einkaufspreis, Zielmarge)
  // Ein Produkt kann das eine haben und das andere nicht. Beides in einer Zahl
  // zusammenzuziehen hieße, dem Leser zu verschweigen, was genau fehlt.
  const mitUnterschied = befunde.filter((b) => b.delta_je_stueck !== null);
  const mitJahr = befunde.filter((b) => b.delta_jahr !== null);

  // Nur Produkte, die TEURER werden, ergeben eine Mehrkosten-Summe. Entlastungen
  // werden getrennt ausgewiesen — sie gegeneinander zu verrechnen versteckt genau
  // die Produkte, um die es geht.
  const teurer = mitJahr.filter((b) => (b.delta_jahr ?? 0) > 0);
  const guenstiger = mitJahr.filter((b) => (b.delta_jahr ?? 0) < 0);

  return {
    deltas,
    befunde: befunde.sort(nachBetrag),
    unter_ziel: unterZiel,
    anzahl_produkte: befunde.length,
    // Achse 1: Gebührenunterschied.
    anzahl_mit_unterschied: mitUnterschied.length,
    anzahl_ohne_unterschied: befunde.length - mitUnterschied.length,
    // Achse 2: Margenurteil.
    anzahl_unter_ziel: unterZiel.length,
    anzahl_im_ziel: befunde.filter((b) => b.status === "im_ziel_ohne_werbung").length,
    anzahl_ohne_ziel: befunde.filter((b) => b.status === "kein_ziel").length,
    anzahl_ohne_ek: befunde.filter((b) => b.status === "kein_ek").length,
    anzahl_ohne_stueckrechnung: befunde.filter((b) => b.status === "nicht_bewertbar").length,
    mehrkosten_jahr: teurer.length ? runde(teurer.reduce((s, b) => s + (b.delta_jahr ?? 0), 0), 0) : null,
    entlastung_jahr: guenstiger.length ? runde(guenstiger.reduce((s, b) => s + (b.delta_jahr ?? 0), 0), 0) : null,
    anzahl_klassenwechsel: befunde.filter((b) => b.klassenwechsel).length,
    anzahl_unsicher: mitUnterschied.filter((b) => b.tabelle_passt === false).length,
  };
}

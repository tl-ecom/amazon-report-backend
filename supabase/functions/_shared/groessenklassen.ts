// groessenklassen.ts — Modul 2 des Fee Decoders: Größenklassen-Korridor.
//
// Frage: Wie weit ist ein Produkt von der nächstniedrigeren Größenklasse
// entfernt, und was würde es sparen, diese Grenze zu unterschreiten?
//
// Datenlage:
//   * Maße und Gewicht kommen von AMAZON (Gebührenvorschau-Report), nicht aus
//     dem Katalog — abgerechnet wird nach dem, was Amazon gemessen hat.
//   * Die Klassengrenzen kommen aus `fee_schedule` (Rate Card, von TL gepflegt).
//     Fehlt die Klasse dort, ist der Befund „nicht bewertbar" — nie geschätzt.
//
// Drei Fallstricke, die hier bewusst behandelt werden:
//   1. Für Pakete zählt der GRÖSSERE Wert aus Stück- und Volumengewicht. Wer die
//      Verpackung kleiner macht, senkt damit auch das Volumengewicht. Das wird
//      mitgerechnet, sonst fällt die Ersparnis zu niedrig aus.
//   2. Ein Befund entsteht nur, wenn die Änderung realistisch ist. Sonst schlägt
//      die App Produktredesigns als „Maßnahme" vor.
//   3. Günstige Artikel folgen einem EIGENEN Tarif (Niedrigpreisversand, Rate
//      Card S. 5) — keiner Ermäßigung auf die Standardtabelle, sondern einer
//      zweiten Tabelle mit eigenen Beträgen. Welche gilt, entscheidet der
//      Artikelpreis. Auf der falschen Tabelle zu rechnen ergibt Ersparnisse, die
//      es nicht gibt; deshalb wird der Tarif hier zuerst bestimmt und die
//      Klassen darauf gefiltert.

/** Höchstens so viel Prozent darf eine Kante schrumpfen, damit es umsetzbar bleibt. */
export const MAX_REDUKTION = 0.15;
/**
 * ...ODER höchstens so viele Zentimeter absolut.
 *
 * Warum beides: Eine reine Prozentregel bestraft dünne Maße unverhältnismäßig.
 * Bei Vanejas Kinder-Warnweste müssten 0,5 cm aus einer 3 cm flachen Verpackung
 * weg — physisch ein bisschen weniger Luft, rechnerisch aber 16,7 % und damit
 * über der Schwelle. Bei 1.738 Stück im Jahr wären 626 € stillschweigend unter
 * den Tisch gefallen. Ein Zentimeter Verpackung ist bei jeder Größe ein
 * Verpackungsthema, kein Produktredesign.
 */
export const MAX_ABSOLUT_CM = 1.0;
/** Unter dieser Ersparnis p.a. lohnt der Aufwand nicht — kein Befund. */
export const MIN_ERSPARNIS_JAHR = 100;
/**
 * Treibstoff- und Logistikaufschlag auf die Versandgebühr, seit 17.04.2026.
 * Die Rate Card nennt die Beträge OHNE ihn — eine Ersparnis, die auf der
 * Tabelle rechnet, fällt also um diesen Anteil zu niedrig aus. Nachgewiesen an
 * Vanejas Daten: gemessene Gebühr = Tabellenwert × 1,015, auf den Cent.
 *
 * NUR im Standardtarif. Bei den Niedrigpreiszeilen trifft der blanke
 * Tabellenwert, ebenfalls an Vanejas Daten geprüft (S.5-Wert / gemessen):
 * Großer Umschlag 2,65 / 2,66 · Standardumschlag 2,12 / 2,13 und 2,28 / 2,29 ·
 * Extra großer Umschlag 3,04 / 3,03. Mit Aufschlag lägen die Werte 4 Cent
 * daneben — der Abstand ist groß genug, um ihn nicht anzuwenden.
 */
export const TREIBSTOFF_AUFSCHLAG = 1.015;

/** Der Aufschlag gilt je Tarif — beim Niedrigpreisversand nicht. */
export function aufschlagFuer(tarif: Tarif): number {
  return tarif === "standard" ? TREIBSTOFF_AUFSCHLAG : 1;
}

/** Rundungsrauschen in den gemeldeten Maßen. */
export const CM_RAUSCHEN = 0.05;
/** Ab dieser Abweichung passt die Tabelle nicht zur gebuchten Gebühr. */
export const TABELLE_ABWEICHUNG = 0.05;

/**
 * Welcher Tarif — nicht zu verwechseln mit dem Gebührenmodell (flache Stufen vs.
 * Grundgebühr + Zuschlag). Der Tarif hängt am PREIS des Artikels, das Modell an
 * seiner Kategorie. Beide werden getrennt gehalten.
 */
export type Tarif = "standard" | "niedrigpreis";

/**
 * Ab diesem Artikelpreis gilt der Standardtarif; darunter der Niedrigpreisversand
 * (Rate Card S. 5: „höchstens 20 € (DE, NL, FR, IT, ES, BE, IE) einschließlich
 * MwSt."). Nur der Rückfall: Nennt die Grenzentabelle einen Wert, gilt der — die
 * Grenze gehört zur Rate Card und ändert sich mit ihr, nicht mit dem Code.
 */
export const NIEDRIGPREIS_GRENZE_CENTS = 2000;

/**
 * Eine Grenze aus `public.fee_preisgrenze`.
 *
 * Die Rate Card nennt NICHT eine Grenze, sondern zwei: 20 € in den meisten
 * Kategorien, aber nur 12 € bei Schönheit/Gesundheit/Körperpflege,
 * Geschäfts-/Industrie-/Wissenschaftsbedarf, Bürobedarf, Lebensmitteln und
 * Feinkost, Büchern, Amazon-Gerätezubehör und Küche (S. 5).
 *
 * An echten Daten belegt — gleiche Klasse, gleicher Marktplatz, beide unter 20 €:
 *   Warnwesten 4er, Automotive, 15,97 € → gemessen 3,03 €, Niedrigpreis 3,04 €
 *   Trennspray 2er, Grocery,    18,97 € → gemessen 3,57 €, Standard    3,47 €
 */
export interface Preisgrenze {
  /** Amazons `product-group`. null = Vorgabe für alle Gruppen ohne eigene Zeile. */
  produktgruppe: string | null;
  grenze_cents: number;
}

/** Gruppennamen robust vergleichen — Amazon schreibt sie nicht immer gleich. */
function normGruppe(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLowerCase();
  return t === "" ? null : t;
}

/**
 * Welche Preisgrenze gilt für diese Produktgruppe?
 *
 * `aus_gruppe` sagt, ob die Grenze aus einer Kategoriezeile stammt oder aus der
 * Vorgabe. Das ist kein Schmuck: Nur bei der Vorgabe besteht das Restrisiko, dass
 * eine Ausnahmekategorie unter einem Namen auftritt, den die Tabelle nicht kennt.
 * Deshalb wird dieser Fall später gegen Amazons tatsächliche Gebühr gegengeprüft.
 */
export function grenzeFuer(
  produktgruppe: string | null,
  grenzen: Preisgrenze[],
  klassen: Klasse[] = [],
): { grenze: number; aus_gruppe: boolean } {
  const gesucht = normGruppe(produktgruppe);
  if (gesucht !== null) {
    const treffer = grenzen.find((g) => normGruppe(g.produktgruppe) === gesucht);
    if (treffer) return { grenze: treffer.grenze_cents, aus_gruppe: true };
  }
  const vorgabe = grenzen.find((g) => normGruppe(g.produktgruppe) === null);
  if (vorgabe) return { grenze: vorgabe.grenze_cents, aus_gruppe: false };
  return { grenze: niedrigpreisGrenze(klassen), aus_gruppe: false };
}

export interface Gewichtsstufe {
  max_weight_g: number | null; // null = oberste Stufe ohne Obergrenze
  fee_eur: number | null;
}

export interface Klasse {
  size_tier: string;
  label: string | null;
  /** Standardtarif oder Niedrigpreisversand — zwei getrennte Tabellen. */
  tarif: Tarif;
  /**
   * Nur bei `tarif = "niedrigpreis"`: Ab diesem Artikelpreis gilt sie NICHT mehr.
   * null = die Tabelle nennt keine eigene Grenze, dann zählt NIEDRIGPREIS_GRENZE_CENTS.
   */
  preis_grenze_cents: number | null;
  max_longest_side_cm: number | null;
  max_median_side_cm: number | null;
  max_shortest_side_cm: number | null;
  /** Flache Stufen (Rate Card S. 6). */
  stufen: Gewichtsstufe[];
  /** Alternatives Modell (Kategorietabellen S. 8): Grundgebühr + Zuschlag je 100 g. */
  grundgebuehr_eur: number | null;
  zuschlag_je_100g_eur: number | null;
  /** Obergrenze Stückgewicht der Klasse (aus der Kategorietabelle). */
  max_weight_g: number | null;
}

export interface Produkt {
  sku: string;
  asin: string | null;
  produktname: string | null;
  laengste_seite_cm: number | null;
  mittlere_seite_cm: number | null;
  kuerzeste_seite_cm: number | null;
  gewicht_g: number | null;
  groessenklasse: string | null;
  /** Amazons `product-group` — entscheidet, WELCHE Preisgrenze gilt. */
  produktgruppe: string | null;
  /** Artikelpreis in Cent — entscheidet, welcher Tarif gilt. */
  preis_cents: number | null;
  /** Von Amazon erwartete Gebühr je Stück in Cent (netto). */
  fulfilment_cents: number | null;
  /** Verkaufte Einheiten im betrachteten Fenster. */
  einheiten: number;
  /** Länge des Fensters in Tagen — für die Hochrechnung aufs Jahr. */
  fenster_tage: number;
}

export interface Blocker {
  kante: "laengste" | "mittlere" | "kuerzeste" | "gewicht";
  ist: number;
  grenze: number;
  weg: number;      // wie viel muss weg (cm bzw. g)
  prozent: number;  // relativ zum Ist
}

export interface KorridorBefund {
  sku: string;
  asin: string | null;
  produktname: string | null;
  status: "chance" | "kleinste_klasse" | "zu_gross" | "zu_klein_ersparnis" | "nicht_bewertbar";
  /** Auf welcher Tabelle gerechnet wurde. null = nicht entscheidbar. */
  tarif: Tarif | null;
  aktuelle_klasse: string | null;
  ziel_klasse: string | null;
  ziel_label: string | null;
  blocker: Blocker[];
  ersparnis_je_stueck: number | null;
  ersparnis_jahr: number | null;
  /** true = Fenster kürzer als ein Jahr, Jahreswert ist hochgerechnet. */
  hochgerechnet: boolean;
  einheiten: number;
  /** Gebühr laut Tabelle vs. was Amazon nennt — weicht das ab, ist die Ersparnis unsicher. */
  tabelle_passt: boolean | null;
  /** Angewandte Preisgrenze des Niedrigpreisversands in Euro. */
  preisgrenze_eur: number | null;
  /** Kam sie aus einer Kategoriezeile (true) oder aus der Vorgabe (false)? */
  grenze_aus_gruppe: boolean | null;
  /**
   * true = die Tarifwahl nach Preis wurde durch Amazons tatsächliche Gebühr
   * widerlegt und korrigiert. Ein Hinweis darauf, dass die Produktgruppe in der
   * Grenzentabelle fehlt.
   */
  tarif_korrigiert: boolean;
  text: string;
  grund: string | null;
}

/**
 * Welcher Tarif passt zu dem, was Amazon tatsächlich abrechnet?
 *
 * Gegenprobe für den Fall, dass die Grenzentabelle die Produktgruppe nicht kennt.
 * Antwortet nur, wenn GENAU ein Kandidat innerhalb der Toleranz liegt — bei zwei
 * Treffern oder keinem ist nichts entschieden, und dann wird nichts behauptet.
 */
export function tarifNachGebuehr(
  gemessen_eur: number,
  kandidaten: Array<{ tarif: Tarif; gebuehr: number | null }>,
): Tarif | null {
  const treffer = kandidaten.filter(
    (k) => k.gebuehr !== null && Math.abs(gemessen_eur - k.gebuehr) <= TABELLE_ABWEICHUNG * k.gebuehr,
  );
  return treffer.length === 1 ? treffer[0].tarif : null;
}

function nz(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Volumengewicht in Gramm: (L x B x H cm³) / 5000 kg. Rate Card S. 4. */
export function volumengewicht(l: number, b: number, h: number): number {
  return (l * b * h) / 5;
}

/**
 * Ab welchem Artikelpreis gilt der Standardtarif? Aus der Tabelle, sonst der
 * dokumentierte Rückfall. Nennen mehrere Zeilen eine Grenze, gilt die höchste —
 * eine Rate Card hat eine Grenze, uneinheitliche Zeilen wären ein Pflegefehler,
 * und die höchste ist die, die der Import zuletzt gesehen hat.
 */
export function niedrigpreisGrenze(klassen: Klasse[]): number {
  const genannt = klassen
    .filter((k) => k.tarif === "niedrigpreis")
    .map((k) => nz(k.preis_grenze_cents))
    .filter((x): x is number => x !== null);
  return genannt.length > 0 ? Math.max(...genannt) : NIEDRIGPREIS_GRENZE_CENTS;
}

/**
 * Welcher Tarif gilt für diesen Artikelpreis bei dieser Grenze?
 *
 * null, wenn Amazon keinen Preis meldet: Dann ist die Frage nicht entscheidbar,
 * und die Standardtabelle zu nehmen wäre genau der Fehler, um den es hier geht.
 */
export function tarifFuer(preis_cents: number | null, grenze_cents: number): Tarif | null {
  const preis = nz(preis_cents);
  if (preis === null) return null;
  return preis < grenze_cents ? "niedrigpreis" : "standard";
}

/** Ergebnis der Tarifwahl: entweder ein Tarif samt seinen Klassen, oder ein Grund. */
export type TarifWahl =
  | {
    tarif: Tarif;
    klassen: Klasse[];
    /** Die angewandte Preisgrenze in Cent — gehört in jeden Befund, damit er prüfbar ist. */
    grenze_cents: number;
    /**
     * Kam die Grenze aus einer Kategoriezeile (true) oder aus der Vorgabe (false)?
     * Bei der Vorgabe ist die Zuordnung nur so gut wie die Grenzentabelle — dieser
     * Fall wird gegen Amazons tatsächliche Gebühr gegengeprüft.
     */
    grenze_aus_gruppe: boolean;
    grund?: undefined;
  }
  | { tarif: null; klassen?: undefined; grenze_cents?: undefined; grenze_aus_gruppe?: undefined; grund: string };

/** Was für die Tarifwahl gebraucht wird — als Objekt, damit die drei Felder nicht verrutschen. */
export interface TarifEingabe {
  preis_cents: number | null;
  groessenklasse: string | null;
  produktgruppe: string | null;
}

/**
 * Welcher Tarif gilt für dieses Produkt, und welche Klassen gehören dazu?
 *
 * Zwei Bedingungen, beide nötig — der Preis allein genügt nicht:
 *   1. Der Artikel liegt unter der Preisgrenze.
 *   2. Seine Größenklasse kommt im Niedrigpreisversand überhaupt vor. Das
 *      Programm deckt nur die kleinen Klassen ab (Umschläge, Kleines Paket bis
 *      400 g — S. 5). Ein günstiger Artikel im Standardpaket ist nicht
 *      qualifiziert und läuft über den Standardtarif. Nachgewiesen an Vaneja:
 *      Geschenktüten (14,97 €) und Kratzbrett (17,97 €) treffen die
 *      Standardtabelle auf den Cent.
 *
 * Der Unterschied zwischen „Klasse nicht dabei" und „Tabelle nicht gepflegt" ist
 * der Kern: Ersteres ist eine Aussage, Letzteres eine Wissenslücke. Nur bei
 * Letzterem wird nichts behauptet.
 *
 * Diese Funktion ist die EINZIGE Stelle, an der die Tarifwahl getroffen wird —
 * Modul 2, Modul 3 und die Gebührenänderungs-Vorschau rufen sie alle auf.
 */
export function waehleTarif(
  p: TarifEingabe, klassen: Klasse[], grenzen: Preisgrenze[] = [],
): TarifWahl {
  const { grenze, aus_gruppe } = grenzeFuer(p.produktgruppe, grenzen, klassen);
  const nachPreis = tarifFuer(p.preis_cents, grenze);
  if (nachPreis === null) {
    return {
      tarif: null,
      grund: "Amazon meldet für dieses Produkt keinen Artikelpreis. Ohne ihn ist nicht " +
        `entscheidbar, ob der Niedrigpreisversand gilt (unter ${(grenze / 100).toFixed(2)} €) ` +
        "oder der Standardtarif — und auf der falschen Tabelle zu rechnen ergäbe eine " +
        "Ersparnis, die es nicht gibt.",
    };
  }

  let tarif: Tarif = nachPreis;
  if (nachPreis === "niedrigpreis") {
    const niedrigpreis = klassen.filter((k) => k.tarif === "niedrigpreis");
    if (niedrigpreis.length === 0) {
      return {
        tarif: null,
        grund: `Der Artikel kostet unter ${(grenze / 100).toFixed(2)} € und fällt damit ` +
          "möglicherweise unter den Niedrigpreisversand (Rate Card S. 5) — eine eigene " +
          "Tabelle, nicht die Standardtabelle. Für diesen Marktplatz ist sie nicht hinterlegt.",
      };
    }
    if (!niedrigpreis.some((k) => k.size_tier === p.groessenklasse)) tarif = "standard";
  }

  const passend = klassen.filter((k) => k.tarif === tarif);
  if (passend.length === 0) {
    return { tarif: null, grund: "Für den Standardtarif ist keine Gebührentabelle hinterlegt." };
  }
  return { tarif, klassen: passend, grenze_cents: grenze, grenze_aus_gruppe: aus_gruppe };
}

/**
 * Wonach wird abgerechnet? Für Pakete der größere Wert aus Stück- und
 * Volumengewicht — beim Niedrigpreisversand dagegen NUR das Stückgewicht:
 * „Bei der Bestimmung des Versandgewichts von Artikeln, die über den
 * Niedrigpreisversand versendet werden, berücksichtigen wir das Volumengewicht
 * nicht." (Rate Card S. 5, Fußnote 1). Eine flachere Verpackung senkt dort also
 * die Gebühr nicht; nur die Klassengrenzen zählen.
 */
export function abrechnungsgewicht(
  tarif: Tarif, stueckgewicht_g: number, l: number, b: number, h: number,
): number {
  return tarif === "niedrigpreis"
    ? stueckgewicht_g
    : Math.max(stueckgewicht_g, volumengewicht(l, b, h));
}

/**
 * Gebühr einer Klasse bei gegebenem Versandgewicht. null, wenn die Klasse für
 * dieses Gewicht keinen Eintrag hat — dann wird nichts behauptet.
 */
export function gebuehrFuer(k: Klasse, versandgewicht_g: number): number | null {
  // Modell A: flache Gewichtsstufen.
  const flach = k.stufen
    .filter((s) => s.fee_eur !== null)
    .sort((a, b) => (a.max_weight_g ?? Infinity) - (b.max_weight_g ?? Infinity));
  if (flach.length > 0) {
    const treffer = flach.find((s) => s.max_weight_g === null || versandgewicht_g <= s.max_weight_g);
    return treffer ? treffer.fee_eur : null; // schwerer als die oberste Stufe -> unbekannt
  }
  // Modell B: Grundgebühr für die ersten 100 g + Zuschlag je weitere 100 g.
  const grund = nz(k.grundgebuehr_eur);
  const zuschlag = nz(k.zuschlag_je_100g_eur);
  if (grund === null || zuschlag === null) return null;
  if (k.max_weight_g !== null && versandgewicht_g > k.max_weight_g) return null;
  const schritte = Math.max(0, Math.ceil((versandgewicht_g - 100) / 100));
  return Math.round((grund + schritte * zuschlag) * 100) / 100;
}

/**
 * Welche Klasse gälte für diese Maße und dieses Gewicht, und was kostet sie?
 *
 * Für Modul 3: Was würde Amazon abrechnen, wenn die KATALOG-Maße stimmten?
 * Genommen wird die günstigste Klasse, in die der Karton hineinpasst — nur
 * innerhalb desselben Gebührenmodells UND desselben Tarifs wie die tatsächlich
 * zugewiesene Klasse: Welches Modell gilt, hängt an der Produktkategorie, welcher
 * Tarif gilt, am Artikelpreis. Beides ändert sich nicht mit der Verpackung.
 *
 * null, wenn keine Klasse passt: dann wird nichts behauptet.
 */
export function klasseFuerMasse(
  kanten: [number, number, number],
  stueckgewicht_g: number,
  klassen: Klasse[],
  wieKlasse?: Klasse,
): { klasse: Klasse; gebuehr: number } | null {
  const [l, b, h] = [...kanten].sort((x, y) => y - x);
  const tarif = wieKlasse?.tarif ?? "standard";
  const versand = abrechnungsgewicht(tarif, stueckgewicht_g, l, b, h);
  const kategoriemodell = (k: Klasse) => k.stufen.length === 0 && k.grundgebuehr_eur !== null;
  const zielArt = wieKlasse ? kategoriemodell(wieKlasse) : null;

  const passend = klassen
    .filter((k) => (wieKlasse ? k.tarif === wieKlasse.tarif : true))
    .filter((k) => zielArt === null || kategoriemodell(k) === zielArt)
    .filter((k) => {
      const grenzen = [nz(k.max_longest_side_cm), nz(k.max_median_side_cm), nz(k.max_shortest_side_cm)];
      if (grenzen.some((g) => g === null)) return false;
      const gs = (grenzen as number[]).slice().sort((x, y) => y - x);
      return l <= gs[0] && b <= gs[1] && h <= gs[2];
    })
    .map((k) => ({ klasse: k, gebuehr: gebuehrFuer(k, versand) }))
    .filter((x): x is { klasse: Klasse; gebuehr: number } => x.gebuehr !== null)
    .sort((a, b2) => a.gebuehr - b2.gebuehr);

  return passend[0] ?? null;
}

/** Passt das Produkt (Maße) in die Klasse? Kanten werden sortiert verglichen. */
function passtInBox(p: Produkt, k: Klasse): boolean {
  const kanten = [nz(p.laengste_seite_cm), nz(p.mittlere_seite_cm), nz(p.kuerzeste_seite_cm)];
  const grenzen = [nz(k.max_longest_side_cm), nz(k.max_median_side_cm), nz(k.max_shortest_side_cm)];
  for (let i = 0; i < 3; i++) {
    const kante = kanten[i], grenze = grenzen[i];
    if (kante === null || grenze === null) return false;
    if (kante > grenze) return false;
  }
  return true;
}

const KANTEN: Array<{ key: Blocker["kante"]; feld: keyof Produkt; grenze: keyof Klasse; name: string }> = [
  { key: "laengste", feld: "laengste_seite_cm", grenze: "max_longest_side_cm", name: "längste Seite" },
  { key: "mittlere", feld: "mittlere_seite_cm", grenze: "max_median_side_cm", name: "mittlere Seite" },
  { key: "kuerzeste", feld: "kuerzeste_seite_cm", grenze: "max_shortest_side_cm", name: "kürzeste Seite" },
];

export function kantenName(k: Blocker["kante"]): string {
  return KANTEN.find((x) => x.key === k)?.name ?? "Gewicht";
}

function runde(n: number, s = 2): number {
  const f = 10 ** s;
  return Math.round(n * f) / f;
}

function leer(p: Produkt, grund: string, tarif: Tarif | null = null): KorridorBefund {
  return {
    sku: p.sku, asin: p.asin, produktname: p.produktname,
    status: "nicht_bewertbar", tarif, aktuelle_klasse: p.groessenklasse,
    ziel_klasse: null, ziel_label: null, blocker: [],
    ersparnis_je_stueck: null, ersparnis_jahr: null, hochgerechnet: false,
    einheiten: p.einheiten, tabelle_passt: null,
    preisgrenze_eur: null, grenze_aus_gruppe: null, tarif_korrigiert: false,
    text: "Nicht bewertbar.", grund,
  };
}

/**
 * Prüft ein Produkt gegen die nächstniedrigere Klasse.
 *
 * `klassen` muss die Klassen EINES Marktplatzes und EINER Gültigkeitsperiode
 * enthalten — Klassen über Zeiträume zu mischen ergäbe Fantasie-Ersparnisse.
 */
export function pruefeKorridor(
  p: Produkt, klassen: Klasse[], grenzen: Preisgrenze[] = [],
): KorridorBefund {
  const l = nz(p.laengste_seite_cm), b = nz(p.mittlere_seite_cm), h = nz(p.kuerzeste_seite_cm);
  const stueck = nz(p.gewicht_g);
  if (l === null || b === null || h === null || stueck === null) {
    return leer(p, "Amazon liefert für dieses Produkt keine vollständigen Maße oder kein Gewicht.");
  }
  if (!p.groessenklasse) return leer(p, "Amazon nennt keine Größenklasse.");

  // ERST der Tarif, dann alles andere: Standardtabelle und Niedrigpreisversand
  // haben dieselben Klassennamen, aber andere Beträge. Wer die Klasse zuerst
  // sucht, findet sie auch in der falschen Tabelle — und rechnet ab da falsch.
  const wahl = waehleTarif(p, klassen, grenzen);
  if (wahl.tarif === null) return leer(p, wahl.grund);
  let tarif = wahl.tarif;
  const { grenze_cents, grenze_aus_gruppe } = wahl;

  // Gegenprobe, wenn die Grenze nur aus der Vorgabe stammt: Dann kennt die
  // Grenzentabelle diese Produktgruppe nicht, und es bleibt die Möglichkeit, dass
  // sie zu den Kategorien mit der niedrigeren Grenze gehört. Amazons tatsächlich
  // erwartete Gebühr entscheidet das — sie ist die härtere Quelle als jede
  // Namenszuordnung. Antwortet die Gegenprobe nicht eindeutig, bleibt es beim
  // Preis-Ergebnis.
  //
  // NUR in eine Richtung: Eine unbekannte Kategorie kann die Grenze ausschließlich
  // SENKEN (20 € -> 12 €, Rate Card S. 5) und ein Produkt damit aus dem Programm
  // nehmen — nie hinein. Ein Artikel über der Vorgabegrenze ist nicht
  // niedrigpreisfähig, egal welche Gebühr zufällig zu welcher Zeile passt. Ohne
  // diese Schranke würde eine Gebühr, die in beiden Tabellen plausibel aussieht,
  // teure Artikel in den falschen Tarif ziehen.
  const gemessen = nz(p.fulfilment_cents);
  let tarif_korrigiert = false;
  if (!grenze_aus_gruppe && gemessen !== null && tarif === "niedrigpreis") {
    const kandidat = (t: Tarif) => {
      const k = klassen.find((x) => x.tarif === t && x.size_tier === p.groessenklasse);
      if (!k) return null;
      const g = gebuehrFuer(k, abrechnungsgewicht(t, stueck, l, b, h));
      return g === null ? null : runde(g * aufschlagFuer(t));
    };
    const gegen = tarifNachGebuehr(gemessen / 100, [
      { tarif: "niedrigpreis", gebuehr: kandidat("niedrigpreis") },
      { tarif: "standard", gebuehr: kandidat("standard") },
    ]);
    if (gegen !== null && gegen !== tarif) {
      tarif = gegen;
      tarif_korrigiert = true;
    }
  }

  const tarifKlassen = klassen.filter((k) => k.tarif === tarif);
  const aktuell = tarifKlassen.find((k) => k.size_tier === p.groessenklasse);
  if (!aktuell) {
    return leer(p, `Die Klasse „${p.groessenklasse}" ist in der Gebührentabelle nicht hinterlegt` +
      `${tarif === "niedrigpreis" ? " (Niedrigpreisversand)" : ""}.`, tarif);
  }

  const versand = abrechnungsgewicht(tarif, stueck, l, b, h);
  const gebuehrJetzt = gebuehrFuer(aktuell, versand);
  if (gebuehrJetzt === null) {
    return leer(p,
      `Für „${p.groessenklasse}" bei ${Math.round(versand)} g Versandgewicht ist keine Gebühr hinterlegt.`,
      tarif);
  }

  // Kandidaten: alles, was bei diesem Versandgewicht guenstiger ist als die
  // aktuelle Klasse. Die naechstniedrigere ist die TEUERSTE davon — der
  // kleinste Schritt, der ueberhaupt etwas bringt.
  //
  // NUR innerhalb derselben Tarifart: Amazon hat zwei Gebuehrenmodelle
  // (Standardtabelle mit festen Gewichtsstufen, Kategorietabelle mit
  // Grundgebuehr + Zuschlag). Welches gilt, haengt an der Produktkategorie und
  // nicht an der Verpackung. Ein Standardtabellen-Produkt in eine
  // Kategorieklasse zu schicken waere eine Ersparnis, die es nie geben wird.
  const istKategoriemodell = (k: Klasse) => k.stufen.length === 0 && k.grundgebuehr_eur !== null;
  const gleicheArt = istKategoriemodell(aktuell);
  const guenstiger = tarifKlassen
    .filter((k) => k.size_tier !== aktuell.size_tier && istKategoriemodell(k) === gleicheArt)
    .map((k) => ({ k, fee: gebuehrFuer(k, versand) }))
    .filter((x): x is { k: Klasse; fee: number } => x.fee !== null && x.fee < gebuehrJetzt - 0.005)
    .sort((a, b2) => b2.fee - a.fee);

  const basis = {
    sku: p.sku, asin: p.asin, produktname: p.produktname, tarif,
    aktuelle_klasse: p.groessenklasse, einheiten: p.einheiten,
    preisgrenze_eur: grenze_cents / 100, grenze_aus_gruppe, tarif_korrigiert,
  };
  // Weicht die Tabelle von dem ab, was Amazon tatsaechlich erwartet, ist die
  // Ersparnis nur so gut wie die Tabelle. Das wird ausgewiesen, nicht verschwiegen.
  //
  // Verglichen wird MIT dem Treibstoffaufschlag: Amazons gemeldete Gebuehr
  // enthaelt ihn, der Tabellenwert nicht. Ohne ihn traegt jeder Standard-Vergleich
  // einen systematischen Fehler von 1,5 % mit sich.
  const erwartet = gebuehrJetzt * aufschlagFuer(tarif);
  const tabelle_passt = gemessen === null
    ? null
    : Math.abs(gemessen / 100 - erwartet) <= TABELLE_ABWEICHUNG * erwartet;

  if (guenstiger.length === 0) {
    return {
      ...basis, status: "kleinste_klasse", ziel_klasse: null, ziel_label: null,
      blocker: [], ersparnis_je_stueck: null, ersparnis_jahr: null,
      hochgerechnet: false, tabelle_passt,
      text: "Bereits in der günstigsten Klasse, die für dieses Gewicht in Frage kommt.",
      grund: null,
    };
  }

  const ziel = guenstiger[0].k;
  const zielGebuehr = guenstiger[0].fee;

  // Was steht im Weg? Erst die Kanten.
  const blocker: Blocker[] = [];
  for (const kdef of KANTEN) {
    const ist = nz(p[kdef.feld] as number | null);
    const grenze = nz(ziel[kdef.grenze] as number | null);
    if (ist === null || grenze === null) continue;
    if (ist > grenze + CM_RAUSCHEN) {
      blocker.push({
        kante: kdef.key, ist: runde(ist, 1), grenze: runde(grenze, 1),
        weg: runde(ist - grenze, 1),
        prozent: runde(((ist - grenze) / ist) * 100, 1),
      });
    }
  }

  // Dann das Gewicht — MIT dem Volumengewicht der kleineren Box gerechnet.
  // Wer die Verpackung auf Zielmaß bringt, senkt das Volumengewicht mit.
  // (Beim Niedrigpreisversand nicht: dort zählt nur das Stückgewicht.)
  const zielL = nz(ziel.max_longest_side_cm) ?? l;
  const zielB = nz(ziel.max_median_side_cm) ?? b;
  const zielH = nz(ziel.max_shortest_side_cm) ?? h;
  const versandDanach = abrechnungsgewicht(
    tarif, stueck, Math.min(l, zielL), Math.min(b, zielB), Math.min(h, zielH),
  );
  const zielGewichtsgrenze = nz(ziel.max_weight_g);
  if (zielGewichtsgrenze !== null && versandDanach > zielGewichtsgrenze) {
    blocker.push({
      kante: "gewicht", ist: Math.round(versandDanach), grenze: Math.round(zielGewichtsgrenze),
      weg: Math.round(versandDanach - zielGewichtsgrenze),
      prozent: runde(((versandDanach - zielGewichtsgrenze) / versandDanach) * 100, 1),
    });
  }

  if (blocker.length === 0) {
    // Passt eigentlich schon hinein — dann stimmt etwas mit der Einstufung nicht.
    return {
      ...basis, status: "nicht_bewertbar", ziel_klasse: ziel.size_tier, ziel_label: ziel.label,
      blocker: [], ersparnis_je_stueck: null, ersparnis_jahr: null, hochgerechnet: false,
      tabelle_passt,
      text: "Nicht bewertbar.",
      grund: `Nach Maßen und Gewicht würde das Produkt in „${ziel.label ?? ziel.size_tier}" passen, ` +
        `Amazon stuft es aber als „${p.groessenklasse}" ein. Das sollte man sich ansehen.`,
    };
  }

  // Gebuehr in der Zielklasse: mit dem NACH der Verkleinerung geltenden Gewicht.
  const zielGebuehrDanach = gebuehrFuer(ziel, versandDanach) ?? zielGebuehr;
  // Beide Seiten mit dem Aufschlag, sonst ist die Ersparnis systematisch zu
  // niedrig — er faellt auf die Gebuehr an, nicht auf die Differenz.
  const jeStueck = runde((gebuehrJetzt - zielGebuehrDanach) * aufschlagFuer(tarif));
  const proTag = p.fenster_tage > 0 ? p.einheiten / p.fenster_tage : 0;
  const einheitenJahr = proTag * 365;
  const jahr = runde(jeStueck * einheitenJahr, 0);
  const hochgerechnet = p.fenster_tage > 0 && p.fenster_tage < 365;

  const zielName = ziel.label ?? ziel.size_tier;
  const gemeinsam = { ...basis, ziel_klasse: ziel.size_tier, ziel_label: ziel.label, blocker, tabelle_passt, hochgerechnet };

  // Realistisch? Nur Kanten pruefen — Gewicht laesst sich nicht prozentual bewerten.
  const kantenBlocker = blocker.filter((x) => x.kante !== "gewicht");
  const unrealistisch = kantenBlocker.filter(
    (x) => x.prozent > MAX_REDUKTION * 100 && x.weg > MAX_ABSOLUT_CM,
  );
  if (unrealistisch.length > 0) {
    return {
      ...gemeinsam, status: "zu_gross",
      ersparnis_je_stueck: jeStueck, ersparnis_jahr: jahr,
      text: `${unrealistisch.map((x) => `${kantenName(x.kante)} ${x.weg} cm (${x.prozent} %)`).join(", ")} ` +
        `über der Grenze zu „${zielName}". Das wäre kein Verpackungsthema mehr, sondern ein anderes Produkt.`,
      grund: null,
    };
  }

  if (jahr < MIN_ERSPARNIS_JAHR) {
    return {
      ...gemeinsam, status: "zu_klein_ersparnis",
      ersparnis_je_stueck: jeStueck, ersparnis_jahr: jahr,
      text: `Rechnerisch möglich, aber bei ${p.einheiten} Einheiten nur ${jahr} € im Jahr — ` +
        `das trägt den Aufwand nicht.`,
      grund: null,
    };
  }

  const blockerText = blocker
    .map((x) => x.kante === "gewicht"
      ? `Gewicht ${x.weg} g`
      : `${kantenName(x.kante)} ${x.weg} cm`)
    .join(" und ");
  const massnahme = kantenBlocker.length > 0
    ? `Verpackung: ${kantenBlocker.map((x) => `${kantenName(x.kante)} auf ≤ ${x.grenze} cm`).join(", ")}.`
    : `Versandgewicht auf ≤ ${blocker[0].grenze} g bringen.`;

  return {
    ...gemeinsam, status: "chance",
    ersparnis_je_stueck: jeStueck, ersparnis_jahr: jahr,
    text: `${blockerText} über der Grenze zu „${zielName}". ` +
      `Ersparnis ${jeStueck.toFixed(2)} € je Einheit → ${jahr} € im Jahr` +
      `${hochgerechnet ? ` (hochgerechnet aus ${p.einheiten} Einheiten in ${p.fenster_tage} Tagen)` : ""}. ` +
      massnahme,
    grund: null,
  };
}

/** Alle Produkte prüfen und die Chancen nach € sortieren. */
export function korridorReport(
  produkte: Produkt[], klassen: Klasse[], grenzen: Preisgrenze[] = [],
) {
  const befunde = produkte.map((p) => pruefeKorridor(p, klassen, grenzen));
  const chancen = befunde.filter((b) => b.status === "chance")
    .sort((a, b) => (b.ersparnis_jahr ?? 0) - (a.ersparnis_jahr ?? 0));
  return {
    befunde,
    chancen,
    summe_ersparnis_jahr: chancen.length
      ? Math.round(chancen.reduce((s, b) => s + (b.ersparnis_jahr ?? 0), 0))
      : null,
    nicht_bewertbar: befunde.filter((b) => b.status === "nicht_bewertbar").length,
    // Wie viele Produkte auf der Niedrigpreistabelle gerechnet wurden. Fehlt sie,
    // stehen sie als „nicht bewertbar" da — dann ist diese Zahl 0 und der Grund
    // steht am Befund.
    niedrigpreis: befunde.filter((b) => b.tarif === "niedrigpreis").length,
    // Ehrlichkeit: wo die Tabelle nicht zur gebuchten Gebühr passt, ist die
    // Ersparnis nur eine Rechnung, keine Zusage.
    unsicher: chancen.filter((b) => b.tabelle_passt === false).length,
    // Wie oft Amazons tatsächliche Gebühr die Tarifwahl nach Preis widerlegt hat.
    // Jeder Fall ist ein Hinweis, dass der Grenzentabelle eine Produktgruppe fehlt
    // — sichtbar, statt still korrigiert.
    tarif_korrigiert: befunde.filter((b) => b.tarif_korrigiert).length,
  };
}

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
// Zwei Fallstricke, die hier bewusst behandelt werden:
//   1. Für Pakete zählt der GRÖSSERE Wert aus Stück- und Volumengewicht. Wer die
//      Verpackung kleiner macht, senkt damit auch das Volumengewicht. Das wird
//      mitgerechnet, sonst fällt die Ersparnis zu niedrig aus.
//   2. Ein Befund entsteht nur, wenn die Änderung realistisch ist. Sonst schlägt
//      die App Produktredesigns als „Maßnahme" vor.

/** Höchstens so viel Prozent darf eine Kante schrumpfen, damit es umsetzbar bleibt. */
export const MAX_REDUKTION = 0.15;
/** Unter dieser Ersparnis p.a. lohnt der Aufwand nicht — kein Befund. */
export const MIN_ERSPARNIS_JAHR = 100;
/** Rundungsrauschen in den gemeldeten Maßen. */
export const CM_RAUSCHEN = 0.05;
/** Ab dieser Abweichung passt die Tabelle nicht zur gebuchten Gebühr. */
export const TABELLE_ABWEICHUNG = 0.05;

export interface Gewichtsstufe {
  max_weight_g: number | null; // null = oberste Stufe ohne Obergrenze
  fee_eur: number | null;
}

export interface Klasse {
  size_tier: string;
  label: string | null;
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
  text: string;
  grund: string | null;
}

function nz(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Volumengewicht in Gramm: (L x B x H cm³) / 5000 kg. Rate Card S. 4. */
export function volumengewicht(l: number, b: number, h: number): number {
  return (l * b * h) / 5;
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

function leer(p: Produkt, grund: string): KorridorBefund {
  return {
    sku: p.sku, asin: p.asin, produktname: p.produktname,
    status: "nicht_bewertbar", aktuelle_klasse: p.groessenklasse,
    ziel_klasse: null, ziel_label: null, blocker: [],
    ersparnis_je_stueck: null, ersparnis_jahr: null, hochgerechnet: false,
    einheiten: p.einheiten, tabelle_passt: null,
    text: "Nicht bewertbar.", grund,
  };
}

/**
 * Prüft ein Produkt gegen die nächstniedrigere Klasse.
 *
 * `klassen` muss die Klassen EINES Marktplatzes und EINER Gültigkeitsperiode
 * enthalten — Klassen über Zeiträume zu mischen ergäbe Fantasie-Ersparnisse.
 */
export function pruefeKorridor(p: Produkt, klassen: Klasse[]): KorridorBefund {
  const l = nz(p.laengste_seite_cm), b = nz(p.mittlere_seite_cm), h = nz(p.kuerzeste_seite_cm);
  const stueck = nz(p.gewicht_g);
  if (l === null || b === null || h === null || stueck === null) {
    return leer(p, "Amazon liefert für dieses Produkt keine vollständigen Maße oder kein Gewicht.");
  }
  if (!p.groessenklasse) return leer(p, "Amazon nennt keine Größenklasse.");

  const aktuell = klassen.find((k) => k.size_tier === p.groessenklasse);
  if (!aktuell) {
    return leer(p, `Die Klasse „${p.groessenklasse}" ist in der Gebührentabelle nicht hinterlegt.`);
  }

  const versand = Math.max(stueck, volumengewicht(l, b, h));
  const gebuehrJetzt = gebuehrFuer(aktuell, versand);
  if (gebuehrJetzt === null) {
    return leer(p, `Für „${p.groessenklasse}" bei ${Math.round(versand)} g Versandgewicht ist keine Gebühr hinterlegt.`);
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
  const istKategorietarif = (k: Klasse) => k.stufen.length === 0 && k.grundgebuehr_eur !== null;
  const gleicheArt = istKategorietarif(aktuell);
  const guenstiger = klassen
    .filter((k) => k.size_tier !== aktuell.size_tier && istKategorietarif(k) === gleicheArt)
    .map((k) => ({ k, fee: gebuehrFuer(k, versand) }))
    .filter((x): x is { k: Klasse; fee: number } => x.fee !== null && x.fee < gebuehrJetzt - 0.005)
    .sort((a, b2) => b2.fee - a.fee);

  const basis = {
    sku: p.sku, asin: p.asin, produktname: p.produktname,
    aktuelle_klasse: p.groessenklasse, einheiten: p.einheiten,
  };
  // Weicht die Tabelle von dem ab, was Amazon tatsaechlich erwartet, ist die
  // Ersparnis nur so gut wie die Tabelle. Das wird ausgewiesen, nicht verschwiegen.
  const gemessen = nz(p.fulfilment_cents);
  const tabelle_passt = gemessen === null
    ? null
    : Math.abs(gemessen / 100 - gebuehrJetzt) <= TABELLE_ABWEICHUNG * gebuehrJetzt;

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
  const zielL = nz(ziel.max_longest_side_cm) ?? l;
  const zielB = nz(ziel.max_median_side_cm) ?? b;
  const zielH = nz(ziel.max_shortest_side_cm) ?? h;
  const versandDanach = Math.max(
    stueck,
    volumengewicht(Math.min(l, zielL), Math.min(b, zielB), Math.min(h, zielH)),
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
  const jeStueck = runde(gebuehrJetzt - zielGebuehrDanach);
  const proTag = p.fenster_tage > 0 ? p.einheiten / p.fenster_tage : 0;
  const einheitenJahr = proTag * 365;
  const jahr = runde(jeStueck * einheitenJahr, 0);
  const hochgerechnet = p.fenster_tage > 0 && p.fenster_tage < 365;

  const zielName = ziel.label ?? ziel.size_tier;
  const gemeinsam = { ...basis, ziel_klasse: ziel.size_tier, ziel_label: ziel.label, blocker, tabelle_passt, hochgerechnet };

  // Realistisch? Nur Kanten pruefen — Gewicht laesst sich nicht prozentual bewerten.
  const kantenBlocker = blocker.filter((x) => x.kante !== "gewicht");
  const unrealistisch = kantenBlocker.filter((x) => x.prozent > MAX_REDUKTION * 100);
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
export function korridorReport(produkte: Produkt[], klassen: Klasse[]) {
  const befunde = produkte.map((p) => pruefeKorridor(p, klassen));
  const chancen = befunde.filter((b) => b.status === "chance")
    .sort((a, b) => (b.ersparnis_jahr ?? 0) - (a.ersparnis_jahr ?? 0));
  return {
    befunde,
    chancen,
    summe_ersparnis_jahr: chancen.length
      ? Math.round(chancen.reduce((s, b) => s + (b.ersparnis_jahr ?? 0), 0))
      : null,
    nicht_bewertbar: befunde.filter((b) => b.status === "nicht_bewertbar").length,
    // Ehrlichkeit: wo die Tabelle nicht zur gebuchten Gebühr passt, ist die
    // Ersparnis nur eine Rechnung, keine Zusage.
    unsicher: chancen.filter((b) => b.tabelle_passt === false).length,
  };
}

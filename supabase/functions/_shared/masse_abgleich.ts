// masse_abgleich.ts — Modul 3 des Fee Decoders: Soll-Ist-Abgleich der Maße.
//
// Gegenüberstellung:
//   SOLL = Katalogmaße (was der Verkäufer eingetragen hat)
//   IST  = von Amazon gemessene Maße (wonach abgerechnet wird)
//
// Zwei sauber getrennte Befundtypen — sie verlangen völlig Verschiedenes:
//
//   1. Amazon misst GRÖSSER als der Katalog und die Gebühr steigt dadurch.
//      Möglicher Erstattungsfall. Wird beziffert und dokumentiert — mehr nicht.
//      Kein automatischer Case, kein Erstattungs-Workflow. Bewusst ausserhalb
//      des Umfangs: einen Erstattungsantrag stellt ein Mensch.
//
//   2. Katalog weicht ab, OHNE dass es die Gebühr ändert.
//      Datenpflegeproblem. Niedrige Dringlichkeit, aber sichtbar — der Verkäufer
//      kalkuliert sonst mit Zahlen, nach denen niemand abrechnet.
//
// Toleranz, damit Messrauschen keine Befunde erzeugt. Amazon misst auf Millimeter
// und rundet; ein halber Zentimeter Unterschied ist keine Abweichung.

/** Unterhalb dieser Differenz ist es Messrauschen, kein Befund. */
export const TOLERANZ_CM = 0.5;
export const TOLERANZ_G = 50;

export interface Paar {
  asin: string;
  sku: string | null;
  produktname: string | null;
  /** SOLL — Katalog. null = nicht gepflegt. */
  katalog: {
    laenge_cm: number | null; breite_cm: number | null;
    hoehe_cm: number | null; gewicht_g: number | null;
  };
  /** IST — von Amazon gemessen. */
  gemessen: {
    laengste_cm: number | null; mittlere_cm: number | null;
    kuerzeste_cm: number | null; gewicht_g: number | null;
  };
  /** Aktuell abgerechnete Gebühr je Stück in Cent. */
  gebuehr_cents: number | null;
  /** Was die Gebühr wäre, wenn die KATALOG-Maße stimmten. null = nicht berechenbar. */
  gebuehr_soll_cents: number | null;
  einheiten: number;
}

export interface Abweichung {
  feld: "laenge" | "breite" | "hoehe" | "gewicht";
  katalog: number;
  gemessen: number;
  differenz: number;
  richtung: "amazon_groesser" | "amazon_kleiner";
}

export interface AbgleichBefund {
  asin: string;
  sku: string | null;
  produktname: string | null;
  status: "gebuehrenrelevant" | "datenpflege" | "stimmig" | "nicht_bewertbar";
  abweichungen: Abweichung[];
  /** Nur bei gebuehrenrelevant: Mehrkosten je Stück und aufs Fenster. */
  mehrkosten_je_stueck: number | null;
  mehrkosten_gesamt: number | null;
  einheiten: number;
  text: string;
  grund: string | null;
}

function nz(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function runde(n: number, s = 2): number {
  const f = 10 ** s;
  return Math.round(n * f) / f;
}

const FELD_NAME: Record<Abweichung["feld"], string> = {
  laenge: "Länge", breite: "Breite", hoehe: "Höhe", gewicht: "Gewicht",
};

/**
 * Vergleicht Katalog- gegen Messwerte.
 *
 * Die Kanten werden SORTIERT verglichen: Amazon liefert längste/mittlere/
 * kürzeste Seite, der Katalog Länge/Breite/Höhe in beliebiger Reihenfolge.
 * Ein Vergleich „Länge gegen längste Seite" würde bei einem flachen Karton, den
 * jemand als 3 × 30 × 20 eingetragen hat, drei Abweichungen erfinden, wo keine ist.
 */
export function pruefeMasse(p: Paar): AbgleichBefund {
  const basis = { asin: p.asin, sku: p.sku, produktname: p.produktname, einheiten: p.einheiten };

  const kKanten = [nz(p.katalog.laenge_cm), nz(p.katalog.breite_cm), nz(p.katalog.hoehe_cm)];
  const gKanten = [nz(p.gemessen.laengste_cm), nz(p.gemessen.mittlere_cm), nz(p.gemessen.kuerzeste_cm)];

  if (kKanten.some((x) => x === null)) {
    return {
      ...basis, status: "nicht_bewertbar", abweichungen: [],
      mehrkosten_je_stueck: null, mehrkosten_gesamt: null,
      text: "Nicht bewertbar.",
      grund: "Im Katalog sind keine vollständigen Verpackungsmaße hinterlegt — es gibt nichts zu vergleichen.",
    };
  }
  if (gKanten.some((x) => x === null)) {
    return {
      ...basis, status: "nicht_bewertbar", abweichungen: [],
      mehrkosten_je_stueck: null, mehrkosten_gesamt: null,
      text: "Nicht bewertbar.",
      grund: "Amazon hat für dieses Produkt keine Maße gemeldet.",
    };
  }

  // Absteigend sortieren, dann paarweise. Beide Seiten beschreiben denselben Karton.
  const kSort = (kKanten as number[]).slice().sort((a, b) => b - a);
  const gSort = (gKanten as number[]).slice().sort((a, b) => b - a);
  const FELDER: Array<Abweichung["feld"]> = ["laenge", "breite", "hoehe"];

  const abweichungen: Abweichung[] = [];
  for (let i = 0; i < 3; i++) {
    const diff = gSort[i] - kSort[i];
    if (Math.abs(diff) > TOLERANZ_CM) {
      abweichungen.push({
        feld: FELDER[i], katalog: runde(kSort[i], 1), gemessen: runde(gSort[i], 1),
        differenz: runde(Math.abs(diff), 1),
        richtung: diff > 0 ? "amazon_groesser" : "amazon_kleiner",
      });
    }
  }

  const kg = nz(p.katalog.gewicht_g), gg = nz(p.gemessen.gewicht_g);
  if (kg !== null && gg !== null && Math.abs(gg - kg) > TOLERANZ_G) {
    abweichungen.push({
      feld: "gewicht", katalog: Math.round(kg), gemessen: Math.round(gg),
      differenz: Math.round(Math.abs(gg - kg)),
      richtung: gg > kg ? "amazon_groesser" : "amazon_kleiner",
    });
  }

  if (abweichungen.length === 0) {
    return {
      ...basis, status: "stimmig", abweichungen: [],
      mehrkosten_je_stueck: null, mehrkosten_gesamt: null,
      text: "Katalog und Messung stimmen überein.", grund: null,
    };
  }

  // Kostet die Abweichung Geld? Nur dann ist es mehr als Datenpflege.
  const ist = nz(p.gebuehr_cents);
  const soll = nz(p.gebuehr_soll_cents);
  const mehr = ist !== null && soll !== null ? ist - soll : null;

  if (mehr !== null && mehr > 0) {
    const jeStueck = runde(mehr / 100);
    return {
      ...basis, status: "gebuehrenrelevant", abweichungen,
      mehrkosten_je_stueck: jeStueck,
      mehrkosten_gesamt: runde(jeStueck * p.einheiten, 2),
      text: `Amazon misst ${beschreibe(abweichungen)} und rechnet danach ab. ` +
        `Das sind ${jeStueck.toFixed(2)} € je Einheit mehr als nach den Katalogmaßen — ` +
        `bei ${p.einheiten} Einheiten ${runde(jeStueck * p.einheiten, 0)} €. ` +
        `Prüfen: Sind die Katalogmaße korrekt? Dann ist das ein Fall für den Amazon-Support.`,
      grund: null,
    };
  }

  return {
    ...basis, status: "datenpflege", abweichungen,
    mehrkosten_je_stueck: null, mehrkosten_gesamt: null,
    text: `Katalog und Messung weichen ab (${beschreibe(abweichungen)}), die Gebühr ändert sich dadurch nicht. ` +
      `Kein Kostenthema — aber wer mit den Katalogmaßen kalkuliert, rechnet mit Zahlen, nach denen niemand abrechnet.`,
    grund: null,
  };
}

function beschreibe(a: Abweichung[]): string {
  return a.map((x) =>
    `${FELD_NAME[x.feld]} ${x.gemessen}${x.feld === "gewicht" ? " g" : " cm"} statt ` +
    `${x.katalog}${x.feld === "gewicht" ? " g" : " cm"}`
  ).join(", ");
}

/** Alle Produkte prüfen; Kostenfälle zuerst, nach € sortiert. */
export function abgleichReport(paare: Paar[]) {
  const befunde = paare.map(pruefeMasse);
  const kosten = befunde.filter((b) => b.status === "gebuehrenrelevant")
    .sort((a, b) => (b.mehrkosten_gesamt ?? 0) - (a.mehrkosten_gesamt ?? 0));
  const pflege = befunde.filter((b) => b.status === "datenpflege");
  return {
    befunde, kosten, pflege,
    summe_mehrkosten: kosten.length
      ? runde(kosten.reduce((s, b) => s + (b.mehrkosten_gesamt ?? 0), 0), 2)
      : null,
    stimmig: befunde.filter((b) => b.status === "stimmig").length,
    nicht_bewertbar: befunde.filter((b) => b.status === "nicht_bewertbar").length,
    hinweis: "Pulse dokumentiert und beziffert nur. Einen Erstattungsantrag stellt ein Mensch.",
  };
}

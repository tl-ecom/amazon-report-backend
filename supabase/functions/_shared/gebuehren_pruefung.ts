// gebuehren_pruefung.ts — Plausibilitaetspruefung der Amazon-Gebuehren je Produkt.
//
// Anlass (09.09.2026): Fuer B0H516MYPV wies Pulse im August 840,78 EUR
// Amazon-Gebuehren aus, tatsaechlich waren es rund 355. Die Verkaufsgebuehr lag
// bei 25,6 % vom Bruttoumsatz statt bei den ueblichen 15 %. Niemandem ist das
// aufgefallen, weil die Zahl fuer sich genommen plausibel aussah.
//
// Diese Pruefungen aendern NICHTS an den Daten. Sie sagen nur, wo eine Zahl
// nicht zu ihrer Umgebung passt — und ueberlassen die Deutung dem Leser.
//
// Reines Modul: keine DB, kein Netz.

/** Verkaufsgebuehr ueber diesem Anteil vom Bruttoumsatz ist erklaerungsbeduerftig. */
export const VERKAUFSGEBUEHR_MAX = 0.20;
/** Amazon-Gebuehren ueber diesem Anteil vom Nettoumsatz ebenso. */
export const GEBUEHRENQUOTE_MAX = 0.50;
/**
 * Ab dieser Abweichung gilt die FBA-Gebuehr einer kleineren Packung als
 * unplausibel gegenueber einer groesseren.
 *
 * 10 %: Amazons Groessenklassen sind grob gestuft, kleine Unterschiede zwischen
 * benachbarten Packungsgroessen sind normal. Ein Zehntel darueber ist es nicht.
 */
export const BUNDLE_TOLERANZ = 0.10;

export interface GebuehrProdukt {
  asin: string;
  produktname?: string | null;
  einheiten: number;
  /** Bruttoumsatz in Euro (mit USt.). */
  umsatz_brutto: number;
  /** Nettoumsatz in Euro. */
  umsatz: number;
  /** Signiert, negativ = Kosten. null = unbekannt. */
  verkaufsgebuehr: number | null;
  fba_gebuehr: number | null;
  gebuehren: number | null;
  /** Anteil der abgerechneten Bestellzeilen, null = unbekannt. */
  gebuehren_abdeckung?: number | null;
}

export interface Befund {
  asin: string;
  art: "verkaufsgebuehr_hoch" | "gebuehrenquote_hoch" | "bundle_unplausibel" | "unvollstaendig";
  text: string;
  /** Die gemessene Zahl, damit der Befund nachrechenbar ist. */
  wert: number | null;
}

function anteil(zaehler: number | null, nenner: number): number | null {
  if (zaehler === null || !Number.isFinite(nenner) || nenner <= 0) return null;
  return Math.abs(zaehler) / nenner;
}

/** Packungsgroesse aus dem Namen, z. B. "3 x 200 ml" -> 3. null = nicht erkennbar. */
export function packungsgroesse(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = name.match(/(\d+)\s*[x×]\s*\d/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 99 ? n : null;
}

/**
 * Alle Befunde zu einer Produktliste.
 *
 * Reihenfolge: erst die produktbezogenen, dann der Vergleich der Packungsgroessen
 * untereinander — der braucht die ganze Liste.
 */
export function pruefeGebuehren(produkte: GebuehrProdukt[]): Befund[] {
  const befunde: Befund[] = [];

  for (const p of produkte) {
    if (p.gebuehren === null) continue;

    const q = anteil(p.verkaufsgebuehr, p.umsatz_brutto);
    if (q !== null && q > VERKAUFSGEBUEHR_MAX) {
      befunde.push({
        asin: p.asin, art: "verkaufsgebuehr_hoch", wert: Math.round(q * 1000) / 10,
        text: `Verkaufsgebühr ist ${(q * 100).toFixed(1)} % vom Bruttoumsatz. `
          + "Amazon nimmt je nach Kategorie 8 bis 15 %. Entweder gehören Gebühren aus "
          + "einer anderen Periode dazu, oder die Kategorie ist teurer als angenommen.",
      });
    }

    const g = anteil(p.gebuehren, p.umsatz);
    if (g !== null && g > GEBUEHRENQUOTE_MAX) {
      befunde.push({
        asin: p.asin, art: "gebuehrenquote_hoch", wert: Math.round(g * 1000) / 10,
        text: `Amazon-Gebühren sind ${(g * 100).toFixed(1)} % vom Nettoumsatz. `
          + "Über der Hälfte bleibt für Ware und Werbung nichts mehr übrig — das ist "
          + "entweder ein Datenfehler oder ein Produkt, das sich nicht trägt.",
      });
    }

    // Unvollstaendige Perioden: niedrige Gebuehren sind dann kein gutes Ergebnis.
    const a = p.gebuehren_abdeckung;
    if (a != null && a < 0.95) {
      befunde.push({
        asin: p.asin, art: "unvollstaendig", wert: Math.round(a * 1000) / 10,
        text: `Erst ${(a * 100).toFixed(0)} % der Bestellzeilen sind abgerechnet. `
          + "Die Gebühren sind unvollständig, nicht niedrig — Marge und Break-even-ACOS "
          + "sind für diesen Zeitraum noch nicht belastbar.",
      });
    }
  }

  // Packungsgroessen untereinander: die kleinere Packung darf nicht mehr FBA
  // kosten als die groessere. Verglichen wird je Einheit, sonst vergleicht man
  // Absatzmengen statt Gebuehren.
  const mitGroesse = produkte
    .filter((p) => p.fba_gebuehr !== null && p.einheiten > 0)
    .map((p) => ({ p, n: packungsgroesse(p.produktname), je: Math.abs(p.fba_gebuehr!) / p.einheiten }))
    .filter((x): x is { p: GebuehrProdukt; n: number; je: number } => x.n !== null);

  for (const klein of mitGroesse) {
    for (const gross of mitGroesse) {
      if (gross.n <= klein.n) continue;
      if (klein.je > gross.je * (1 + BUNDLE_TOLERANZ)) {
        befunde.push({
          asin: klein.p.asin, art: "bundle_unplausibel",
          wert: Math.round((klein.je / gross.je) * 100) / 100,
          text: `FBA-Gebühr je Einheit ${klein.je.toFixed(2)} € bei ${klein.n}er-Packung, `
            + `aber nur ${gross.je.toFixed(2)} € bei ${gross.n}er-Packung. `
            + "Die kleinere Packung kann nicht teurer versendet werden als die größere.",
        });
      }
    }
  }

  return befunde;
}

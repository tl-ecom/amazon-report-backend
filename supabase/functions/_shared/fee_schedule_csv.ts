// fee_schedule_csv.ts — Import der Amazon-Gebührentabelle (Größenklassen).
//
// Warum überhaupt manuell? Amazon veröffentlicht die Größenklassen-Grenzen und
// Versandgebühren als Webseite/PDF, nicht per API. Pulse darf sie weder raten
// noch scrapen — also pflegt TL sie einmal je Gültigkeitszeitraum als CSV.
//
// Der Report GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA liefert je SKU bereits Amazons
// eigene Klasse (`product-size-weight-band`) und die erwartete Gebühr. Diese
// Tabelle liefert das, was dort FEHLT: die GRENZEN der Klassen. Erst damit lässt
// sich sagen „3,2 cm von der nächstkleineren Klasse entfernt".
//
// Der Schlüssel `size_tier` muss exakt Amazons Bandnamen entsprechen — sonst
// findet der Abgleich nichts. Der Import meldet daher zurück, welche Namen er
// gelesen hat, statt sie stillschweigend zu normalisieren. Amazon liefert
// englische IDs: StandardParcel, SmallParcel, ExtraLargeEnvelope, ...
//
// EINE ZEILE JE GEWICHTSSTUFE, nicht je Klasse: innerhalb von StandardParcel
// reichen die Gebühren im echten Bestand von 4,01 € bis 6,12 €. Die Klasse
// allein bestimmt die Gebühr also nicht — erst Klasse + Gewichtsstufe tun es.

import { csvZeilen, ekCents, erkenneTrenner, datumIso } from "./sellerboard.ts";

export interface GebuehrZeile {
  marketplace: string;
  size_tier: string;
  max_longest_side_cm: number | null;
  max_median_side_cm: number | null;
  max_shortest_side_cm: number | null;
  max_weight_g: number | null;
  fee_eur: number | null;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

export interface GebuehrParseErgebnis {
  zeilen: GebuehrZeile[];
  erkannt: Record<string, string | null>;
  spalten: string[];
  uebersprungen: number;
  warnungen: string[];
}

function norm(s: string): string {
  return s.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

const SPALTEN: Record<string, string[]> = {
  size_tier: ["groessenklasse", "sizetier", "productsizeweightband", "band", "klasse", "tier"],
  max_longest_side_cm: ["maxlaengsteseite", "laengsteseite", "maxlongestside", "longestside", "laenge"],
  max_median_side_cm: ["maxmittlereseite", "mittlereseite", "maxmedianside", "medianside", "breite"],
  max_shortest_side_cm: ["maxkuerzesteseite", "kuerzesteseite", "maxshortestside", "shortestside", "hoehe"],
  max_weight_g: ["maxgewicht", "gewicht", "maxweight", "weight"],
  fee_eur: ["gebuehr", "versandgebuehr", "fee", "fulfilmentfee", "fulfillmentfee", "preis"],
  gueltig_ab: ["gueltigab", "validfrom", "ab", "startdate"],
  gueltig_bis: ["gueltigbis", "validto", "bis", "enddate"],
  marketplace: ["marktplatz", "marketplace", "land", "country"],
};

function findeSpalte(kopf: string[], kandidaten: string[]): number {
  const normiert = kopf.map(norm);
  for (const k of kandidaten) {
    const i = normiert.indexOf(k);
    if (i >= 0) return i;
  }
  for (const k of kandidaten) {
    const i = normiert.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Maßangabe -> cm. Beherrscht "45", "45 cm", "45,5". Grenzenlose Klassen
 * ("unbegrenzt", "-", leer) -> null: keine Obergrenze ist NICHT die Grenze 0.
 */
export function massCm(roh: unknown): number | null {
  const t = String(roh ?? "").trim().toLowerCase();
  if (t === "" || t === "-" || t.startsWith("unbegrenzt") || t.startsWith("unlimited")) return null;
  const c = ekCents(t);
  return c === null ? null : c / 100;
}

/**
 * Gewichtsangabe -> Gramm. "12 kg" / "12kg" -> 12000, "500 g" -> 500.
 * Ohne Einheit wird kg angenommen (so steht es in Amazons Tabelle).
 */
export function gewichtGramm(roh: unknown): number | null {
  const t = String(roh ?? "").trim().toLowerCase();
  if (t === "" || t === "-" || t.startsWith("unbegrenzt") || t.startsWith("unlimited")) return null;
  const c = ekCents(t);
  if (c === null) return null;
  const zahl = c / 100;
  // "g" nur dann, wenn NICHT Teil von "kg" — sonst kippt jedes kg auf Gramm.
  if (/\bg\b|gramm|gram/.test(t) && !/kg|kilo/.test(t)) return zahl;
  return zahl * 1000;
}

/**
 * Liest die Gebührentabelle. Zeilen ohne Klassennamen werden übersprungen und
 * gezählt — nie stillschweigend verworfen.
 */
export function parseGebuehrenCsv(text: string, standardAb: string): GebuehrParseErgebnis {
  const erg: GebuehrParseErgebnis = {
    zeilen: [], erkannt: {}, spalten: [], uebersprungen: 0, warnungen: [],
  };
  const roh = String(text ?? "");
  if (roh.trim() === "") {
    erg.warnungen.push("Die Datei ist leer.");
    return erg;
  }
  const ersteZeile = roh.split(/\r?\n/, 1)[0] ?? "";
  const zeilen = csvZeilen(roh, erkenneTrenner(ersteZeile));
  if (zeilen.length < 2) {
    erg.warnungen.push("Die Datei enthält keine Datenzeilen unter der Kopfzeile.");
    return erg;
  }
  const kopf = zeilen[0].map((s) => s.trim());
  erg.spalten = kopf;

  const idx: Record<string, number> = {};
  for (const [feld, kandidaten] of Object.entries(SPALTEN)) {
    idx[feld] = findeSpalte(kopf, kandidaten);
    erg.erkannt[feld] = idx[feld] >= 0 ? kopf[idx[feld]] : null;
  }
  if (idx.size_tier < 0) {
    erg.warnungen.push(
      'Keine Spalte mit der Größenklasse gefunden. Erwartet z. B. „Größenklasse“ oder „size_tier“.',
    );
    return erg;
  }
  if (idx.fee_eur < 0) {
    erg.warnungen.push("Keine Gebührenspalte gefunden — die Klassen werden ohne Betrag importiert.");
  }

  const hole = (z: string[], feld: string): string =>
    idx[feld] >= 0 ? (z[idx[feld]] ?? "").trim() : "";

  for (const z of zeilen.slice(1)) {
    const tier = hole(z, "size_tier");
    if (tier === "") { erg.uebersprungen++; continue; }
    const fee = ekCents(hole(z, "fee_eur"));
    erg.zeilen.push({
      marketplace: (hole(z, "marketplace") || "DE").toUpperCase().slice(0, 8),
      size_tier: tier,
      max_longest_side_cm: massCm(hole(z, "max_longest_side_cm")),
      max_median_side_cm: massCm(hole(z, "max_median_side_cm")),
      max_shortest_side_cm: massCm(hole(z, "max_shortest_side_cm")),
      max_weight_g: gewichtGramm(hole(z, "max_weight_g")),
      fee_eur: fee === null ? null : fee / 100,
      gueltig_ab: datumIso(hole(z, "gueltig_ab")) ?? standardAb,
      gueltig_bis: datumIso(hole(z, "gueltig_bis")),
    });
  }
  if (erg.uebersprungen > 0) {
    erg.warnungen.push(`${erg.uebersprungen} Zeile(n) ohne Größenklasse übersprungen.`);
  }
  return erg;
}

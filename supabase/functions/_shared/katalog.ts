// katalog.ts — reine Umwandlung der Catalog-Items-Antwort in Katalogmaße.
//
// Amazon liefert Maße als { value, unit }, wobei die Einheit je Marktplatz und
// je Angebot verschieden sein kann (centimeters, inches, grams, pounds...).
// Unbekannte Einheit -> null, nie eine Zahl in falscher Einheit übernehmen:
// ein Zoll-Wert als Zentimeter gelesen würde eine Maßabweichung erfinden.

export interface KatalogMass {
  asin: string;
  marketplace: string;
  laenge_cm: number | null;
  breite_cm: number | null;
  hoehe_cm: number | null;
  gewicht_g: number | null;
  produkt_laenge_cm: number | null;
  produkt_breite_cm: number | null;
  produkt_hoehe_cm: number | null;
  produkt_gewicht_g: number | null;
  marke: string | null;
  raw: unknown;
}

/** { value, unit } -> Zentimeter. Unbekannte Einheit -> null. */
export function massCm(feld: any): number | null {
  const v = Number(feld?.value);
  if (!Number.isFinite(v)) return null;
  const e = String(feld?.unit ?? "").trim().toLowerCase();
  if (e === "" || e.startsWith("cm") || e.startsWith("centimet") || e.startsWith("zentimet")) return v;
  if (e.startsWith("mm") || e.startsWith("millimet")) return v / 10;
  if (e.startsWith("meter") || e === "m") return v * 100;
  if (e.startsWith("in") || e.startsWith("zoll") || e === '"') return v * 2.54;
  if (e.startsWith("f")) return v * 30.48; // feet/foot
  return null;
}

/** { value, unit } -> Gramm. Unbekannte Einheit -> null. */
export function massG(feld: any): number | null {
  const v = Number(feld?.value);
  if (!Number.isFinite(v)) return null;
  const e = String(feld?.unit ?? "").trim().toLowerCase();
  if (e.startsWith("g") && !e.startsWith("gr n")) return v;
  if (e === "" || e.startsWith("kg") || e.startsWith("kilo")) return v * 1000;
  if (e.startsWith("lb") || e.startsWith("pound")) return v * 453.59237;
  if (e.startsWith("oz") || e.startsWith("ounce")) return v * 28.349523125;
  if (e.startsWith("mg") || e.startsWith("milligram")) return v / 1000;
  return null;
}

/**
 * Wandelt einen Catalog-Items-Treffer um.
 *
 * `dimensions` ist eine LISTE je Marktplatz — der falsche Eintrag würde die
 * Maße eines anderen Landes einlesen. Deshalb wird gezielt gesucht und, wenn
 * der Marktplatz nicht dabei ist, nichts übernommen.
 */
export function baueKatalogMass(
  item: any, marketplaceId: string, marketplace: string,
): KatalogMass | null {
  const asin = String(item?.asin ?? "").trim();
  if (!asin) return null;

  const liste = Array.isArray(item?.dimensions) ? item.dimensions : [];
  const treffer = liste.find((d: any) => d?.marketplaceId === marketplaceId) ?? null;
  const paket = treffer?.package ?? null;
  const produkt = treffer?.item ?? null;

  const marke = (Array.isArray(item?.summaries)
    ? item.summaries.find((s: any) => s?.marketplaceId === marketplaceId)?.brand
    : null) ?? null;

  return {
    asin, marketplace,
    laenge_cm: massCm(paket?.length),
    breite_cm: massCm(paket?.width),
    hoehe_cm: massCm(paket?.height),
    gewicht_g: massG(paket?.weight),
    produkt_laenge_cm: massCm(produkt?.length),
    produkt_breite_cm: massCm(produkt?.width),
    produkt_hoehe_cm: massCm(produkt?.height),
    produkt_gewicht_g: massG(produkt?.weight),
    marke: marke ? String(marke).slice(0, 120) : null,
    raw: treffer ?? item?.dimensions ?? null,
  };
}

/** Hat der Eintrag überhaupt verwertbare Verpackungsmaße? */
export function hatPaketmasse(k: KatalogMass): boolean {
  return k.laenge_cm !== null && k.breite_cm !== null && k.hoehe_cm !== null;
}

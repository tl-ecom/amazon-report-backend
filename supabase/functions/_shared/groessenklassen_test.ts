import { assertEquals } from "jsr:@std/assert@1";
import {
  gebuehrFuer, korridorReport, pruefeKorridor, volumengewicht,
  type Klasse, type Produkt,
} from "./groessenklassen.ts";

// Echte Werte aus der FBA Rate Card DE, gültig ab 01.07.2026, Spalte "Nur DE".
const KLEINES_PAKET: Klasse = {
  size_tier: "SmallParcel", label: "Kleines Paket",
  max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 12,
  stufen: [
    { max_weight_g: 150, fee_eur: 3.38 }, { max_weight_g: 400, fee_eur: 3.39 },
    { max_weight_g: 900, fee_eur: 3.40 }, { max_weight_g: 1400, fee_eur: 3.41 },
    { max_weight_g: 1900, fee_eur: 3.43 }, { max_weight_g: 3900, fee_eur: 4.54 },
  ],
  grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 3900,
};
const STANDARDPAKET: Klasse = {
  size_tier: "StandardParcel", label: "Standardpaket",
  max_longest_side_cm: 45, max_median_side_cm: 34, max_shortest_side_cm: 26,
  stufen: [
    { max_weight_g: 150, fee_eur: 3.39 }, { max_weight_g: 400, fee_eur: 3.42 },
    { max_weight_g: 900, fee_eur: 3.44 }, { max_weight_g: 1400, fee_eur: 3.93 },
    { max_weight_g: 1900, fee_eur: 3.95 }, { max_weight_g: 2900, fee_eur: 4.55 },
    { max_weight_g: 3900, fee_eur: 5.09 }, { max_weight_g: 5900, fee_eur: 5.22 },
    { max_weight_g: 8900, fee_eur: 6.03 }, { max_weight_g: 11900, fee_eur: 6.65 },
  ],
  grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 11900,
};
const KLASSEN = [KLEINES_PAKET, STANDARDPAKET];

function produkt(over: Partial<Produkt> = {}): Produkt {
  return {
    sku: "TEST-1", asin: "B0TEST", produktname: "Testprodukt",
    laengste_seite_cm: 40, mittlere_seite_cm: 24, kuerzeste_seite_cm: 11,
    gewicht_g: 800, groessenklasse: "StandardParcel",
    fulfilment_cents: 344, einheiten: 1000, fenster_tage: 365,
    ...over,
  };
}

Deno.test("volumengewicht: Rate-Card-Formel (LxBxH)/5000 kg", () => {
  assertEquals(volumengewicht(45, 34, 26), 7956); // = 7,956 kg
  assertEquals(volumengewicht(10, 10, 10), 200);
});

Deno.test("gebuehrFuer: trifft die richtige Gewichtsstufe", () => {
  assertEquals(gebuehrFuer(STANDARDPAKET, 150), 3.39);
  assertEquals(gebuehrFuer(STANDARDPAKET, 151), 3.42);
  assertEquals(gebuehrFuer(STANDARDPAKET, 2900), 4.55);
  // Schwerer als die oberste Stufe -> unbekannt, nicht die oberste Gebuehr.
  assertEquals(gebuehrFuer(STANDARDPAKET, 12000), null);
});

Deno.test("gebuehrFuer: Kategorietabelle rechnet Grundgebuehr + Zuschlag", () => {
  const kp3: Klasse = {
    size_tier: "SmallParcel3", label: "Kleines Paket 3",
    max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 12,
    stufen: [], grundgebuehr_eur: 3.38, zuschlag_je_100g_eur: 0.07, max_weight_g: 3900,
  };
  assertEquals(gebuehrFuer(kp3, 100), 3.38);          // Grundgebuehr
  assertEquals(gebuehrFuer(kp3, 780), 3.87);          // 3,38 + 7 x 0,07
  assertEquals(gebuehrFuer(kp3, 5000), null);         // ueber der Klassengrenze
});

Deno.test("pruefeKorridor: findet den Blocker und rechnet die Ersparnis", () => {
  // 40 cm lang -> 5 cm ueber "Kleines Paket" (35 cm). Das sind 12,5 %, also
  // innerhalb der 15-%-Schwelle.
  const b = pruefeKorridor(produkt(), KLASSEN);
  assertEquals(b.status, "chance");
  assertEquals(b.ziel_klasse, "SmallParcel");
  assertEquals(b.blocker.length, 1);
  assertEquals(b.blocker[0].kante, "laengste");
  assertEquals(b.blocker[0].weg, 5);
  assertEquals(b.blocker[0].grenze, 35);
  // Versandgewicht jetzt: max(800, 40*24*11/5=2112) = 2112 -> Standardpaket 4,55.
  // Nach Verkleinerung: max(800, 35*24*11/5=1848) = 1848 -> Kleines Paket 3,43.
  assertEquals(b.ersparnis_je_stueck, 1.12);
  assertEquals(b.ersparnis_jahr, 1120);
  assertEquals(b.hochgerechnet, false);
  assertEquals(b.text.includes("längste Seite 5 cm"), true);
  assertEquals(b.text.includes("≤ 35 cm"), true);
});

Deno.test("pruefeKorridor: zwei zu grosse Kanten werden BEIDE genannt", () => {
  const b = pruefeKorridor(produkt({
    laengste_seite_cm: 38, mittlere_seite_cm: 27, kuerzeste_seite_cm: 11, gewicht_g: 500,
  }), KLASSEN);
  assertEquals(b.blocker.map((x) => x.kante), ["laengste", "mittlere"]);
});

Deno.test("pruefeKorridor: unrealistische Verkleinerung wird nicht als Massnahme verkauft", () => {
  // 45 cm -> 35 cm waeren 22 % weg. Das ist ein anderes Produkt, keine Verpackung.
  const b = pruefeKorridor(produkt({ laengste_seite_cm: 45 }), KLASSEN);
  assertEquals(b.status, "zu_gross");
  assertEquals(b.text.includes("anderes Produkt"), true);
});

Deno.test("pruefeKorridor: Volumengewicht der kleineren Box wird mitgerechnet", () => {
  // Schweres Volumen: ohne Nachrechnen des Volumengewichts fiele die Ersparnis
  // zu niedrig aus, weil die Zielklasse mit dem ALTEN Gewicht bepreist wuerde.
  const b = pruefeKorridor(produkt({
    laengste_seite_cm: 38, mittlere_seite_cm: 25, kuerzeste_seite_cm: 12, gewicht_g: 300,
  }), KLASSEN);
  // jetzt: max(300, 38*25*12/5=2280) -> Standardpaket 4,55
  // danach: max(300, 35*25*12/5=2100) -> Kleines Paket 4,54 (Stufe <=3900)
  assertEquals(b.status, "zu_klein_ersparnis"); // 0,01 EUR/Stueck
  assertEquals(b.ersparnis_je_stueck, 0.01);
});

Deno.test("pruefeKorridor: zu kleine Jahresersparnis erzeugt keinen Befund", () => {
  const b = pruefeKorridor(produkt({ einheiten: 20 }), KLASSEN);
  assertEquals(b.status, "zu_klein_ersparnis");
  assertEquals(b.text.includes("trägt den Aufwand nicht"), true);
});

Deno.test("pruefeKorridor: kurzes Fenster wird hochgerechnet UND gekennzeichnet", () => {
  const b = pruefeKorridor(produkt({ einheiten: 250, fenster_tage: 90 }), KLASSEN);
  assertEquals(b.hochgerechnet, true);
  assertEquals(b.ersparnis_jahr, Math.round(1.12 * (250 / 90) * 365));
  assertEquals(b.text.includes("hochgerechnet"), true);
});

Deno.test("pruefeKorridor: fehlende Klasse in der Tabelle -> nicht bewertbar", () => {
  const b = pruefeKorridor(produkt({ groessenklasse: "MediumParcel2" }), KLASSEN);
  assertEquals(b.status, "nicht_bewertbar");
  assertEquals(b.grund?.includes("nicht hinterlegt"), true);
  assertEquals(b.ersparnis_jahr, null); // nichts geschaetzt
});

Deno.test("pruefeKorridor: fehlende Masse -> nicht bewertbar statt Annahme", () => {
  assertEquals(pruefeKorridor(produkt({ laengste_seite_cm: null }), KLASSEN).status, "nicht_bewertbar");
  assertEquals(pruefeKorridor(produkt({ gewicht_g: null }), KLASSEN).status, "nicht_bewertbar");
  assertEquals(pruefeKorridor(produkt({ groessenklasse: null }), KLASSEN).status, "nicht_bewertbar");
});

Deno.test("pruefeKorridor: kleinste Klasse -> keine Chance, aber auch kein Fehler", () => {
  const b = pruefeKorridor(produkt({
    groessenklasse: "SmallParcel", laengste_seite_cm: 30,
    mittlere_seite_cm: 20, kuerzeste_seite_cm: 10, gewicht_g: 500,
  }), KLASSEN);
  assertEquals(b.status, "kleinste_klasse");
  assertEquals(b.ersparnis_jahr, null);
});

Deno.test("pruefeKorridor: Tabelle passt nicht zur gebuchten Gebuehr -> markiert", () => {
  // Amazon nennt 6,00 EUR, die Tabelle sagt 4,55 -> Ersparnis bleibt eine Rechnung.
  const b = pruefeKorridor(produkt({ fulfilment_cents: 600 }), KLASSEN);
  assertEquals(b.tabelle_passt, false);
  const gut = pruefeKorridor(produkt({ fulfilment_cents: 455 }), KLASSEN);
  assertEquals(gut.tabelle_passt, true);
});

Deno.test("pruefeKorridor: Kategorietarif und Standardtarif werden nicht vermischt", () => {
  // Welches Gebuehrenmodell gilt, haengt an der Produktkategorie — nicht an der
  // Verpackung. Ein Wechsel zwischen den Modellen ist keine Massnahme.
  const kp1: Klasse = {
    size_tier: "SmallParcel1", label: "Kleines Paket 1",
    max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 7,
    stufen: [], grundgebuehr_eur: 3.30, zuschlag_je_100g_eur: 0.05, max_weight_g: 3900,
  };
  const kp3: Klasse = {
    size_tier: "SmallParcel3", label: "Kleines Paket 3",
    max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 12,
    stufen: [], grundgebuehr_eur: 3.38, zuschlag_je_100g_eur: 0.07, max_weight_g: 3900,
  };
  const alle = [...KLASSEN, kp1, kp3];

  // Standardtarif-Produkt darf NICHT in eine Kategorieklasse geschickt werden.
  const std = pruefeKorridor(produkt({
    groessenklasse: "StandardParcel", laengste_seite_cm: 40,
    mittlere_seite_cm: 24, kuerzeste_seite_cm: 11, gewicht_g: 800,
  }), alle);
  assertEquals(std.ziel_klasse, "SmallParcel");

  // Kategorietarif-Produkt bleibt in der Kategorietabelle.
  const kat = pruefeKorridor(produkt({
    groessenklasse: "SmallParcel3", laengste_seite_cm: 20,
    mittlere_seite_cm: 15, kuerzeste_seite_cm: 11, gewicht_g: 780, einheiten: 5000,
  }), alle);
  assertEquals(kat.ziel_klasse, "SmallParcel1");
  assertEquals(kat.blocker.map((x) => x.kante), ["kuerzeste"]);
});

Deno.test("korridorReport: sortiert nach Euro und summiert nur echte Chancen", () => {
  const r = korridorReport([
    produkt({ sku: "A", einheiten: 1000 }),
    produkt({ sku: "B", einheiten: 3000 }),
    produkt({ sku: "C", groessenklasse: "MediumParcel2" }), // nicht bewertbar
  ], KLASSEN);
  assertEquals(r.chancen.map((c) => c.sku), ["B", "A"]);
  assertEquals(r.summe_ersparnis_jahr, 1120 + 3360);
  assertEquals(r.nicht_bewertbar, 1);
});

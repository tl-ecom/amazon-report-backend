import { assertEquals } from "jsr:@std/assert@1";
import {
  abrechnungsgewicht, aufschlagFuer, gebuehrFuer, klasseFuerMasse, korridorReport,
  NIEDRIGPREIS_GRENZE_CENTS, niedrigpreisGrenze, pruefeKorridor,
  TREIBSTOFF_AUFSCHLAG, volumengewicht,
  type Klasse, type Produkt,
} from "./groessenklassen.ts";

// Echte Werte aus der FBA Rate Card DE, gültig ab 01.07.2026, Spalte "Nur DE".
const KLEINES_PAKET: Klasse = {
  size_tier: "SmallParcel", label: "Kleines Paket",
  tarif: "standard", preis_grenze_cents: null,
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
  tarif: "standard", preis_grenze_cents: null,
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
    preis_cents: 2997, fulfilment_cents: 344, einheiten: 1000, fenster_tage: 365,
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
    tarif: "standard", preis_grenze_cents: null,
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
  // Differenz 1,12 plus 1,5 % Treibstoffaufschlag = 1,14.
  assertEquals(b.ersparnis_je_stueck, 1.14);
  assertEquals(b.ersparnis_jahr, 1140);
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

Deno.test("pruefeKorridor: halber Zentimeter aus flacher Verpackung bleibt machbar", () => {
  // Echter Fall Vaneja (Kinder-Warnweste 2er): 3,0 -> 2,5 cm sind 16,7 % und
  // damit ueber der Prozentschwelle — aber nur 0,5 cm. Das ist weniger Luft in
  // der Verpackung, kein anderes Produkt.
  //
  // Der Preis steht hier bewusst ueber der Niedrigpreisgrenze: Geprueft wird die
  // Machbarkeitsregel, nicht die Tarifwahl. Denselben Artikel zu seinem echten
  // Preis (9,97 €) prueft der Test darunter.
  const grossUmschlag: Klasse = {
    size_tier: "LargeEnvelope", label: "Großer Umschlag",
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: 33, max_median_side_cm: 23, max_shortest_side_cm: 4,
    stufen: [{ max_weight_g: 960, fee_eur: 3.04 }],
    grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 960,
  };
  const standardUmschlag: Klasse = {
    size_tier: "StandardEnvelope", label: "Standardumschlag",
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: 33, max_median_side_cm: 23, max_shortest_side_cm: 2.5,
    stufen: [{ max_weight_g: 210, fee_eur: 2.57 }, { max_weight_g: 460, fee_eur: 2.68 }],
    grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 460,
  };
  const b = pruefeKorridor(produkt({
    sku: "E9-2MFL-TXNN", groessenklasse: "LargeEnvelope",
    laengste_seite_cm: 26.34, mittlere_seite_cm: 21.69, kuerzeste_seite_cm: 3,
    gewicht_g: 170, einheiten: 1738, preis_cents: 2997, fulfilment_cents: 266,
  }), [grossUmschlag, standardUmschlag]);
  assertEquals(b.status, "chance");
  assertEquals(b.blocker[0].kante, "kuerzeste");
  assertEquals(b.blocker[0].weg, 0.5);
  assertEquals(b.blocker[0].prozent, 16.7); // ueber 15 %, aber unter 1 cm
  assertEquals(b.ersparnis_je_stueck, 0.37); // 0,36 + Treibstoffaufschlag
  assertEquals(b.ersparnis_jahr, 643);
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
  assertEquals(b.ersparnis_jahr, Math.round(1.14 * (250 / 90) * 365));
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
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 7,
    stufen: [], grundgebuehr_eur: 3.30, zuschlag_je_100g_eur: 0.05, max_weight_g: 3900,
  };
  const kp3: Klasse = {
    size_tier: "SmallParcel3", label: "Kleines Paket 3",
    tarif: "standard", preis_grenze_cents: null,
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

// --- Niedrigpreisversand (Rate Card S. 5) ---------------------------------
//
// Artikel unter der Preisgrenze rechnet Amazon nach einer EIGENEN Tabelle ab.
// Auf der Standardtabelle gerechnet kommen Ersparnisse heraus, die es nicht gibt
// — nachgewiesen an Vaneja: die Warnwesten unter 20 € liegen 0,43 bis 0,59 €
// unter dem, was die Standardtabelle sagt.

/** Umschlagsklassen im Standardtarif — echte Werte, Rate Card DE ab 01.07.2026. */
const GROSSER_UMSCHLAG: Klasse = {
  size_tier: "LargeEnvelope", label: "Großer Umschlag",
  tarif: "standard", preis_grenze_cents: null,
  max_longest_side_cm: 33, max_median_side_cm: 23, max_shortest_side_cm: 4,
  stufen: [{ max_weight_g: 960, fee_eur: 3.04 }],
  grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 960,
};
const STANDARD_UMSCHLAG: Klasse = {
  size_tier: "StandardEnvelope", label: "Standardumschlag",
  tarif: "standard", preis_grenze_cents: null,
  max_longest_side_cm: 33, max_median_side_cm: 23, max_shortest_side_cm: 2.5,
  stufen: [{ max_weight_g: 210, fee_eur: 2.57 }, { max_weight_g: 460, fee_eur: 2.68 }],
  grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 460,
};

/** Echte Werte, Rate Card S. 5, Spalte „Nur DE", gültig ab 01.07.2026. */
const NP_GROSSER_UMSCHLAG: Klasse = {
  ...GROSSER_UMSCHLAG, tarif: "niedrigpreis", preis_grenze_cents: 2000,
  stufen: [{ max_weight_g: 960, fee_eur: 2.65 }],
};
const NP_STANDARD_UMSCHLAG: Klasse = {
  ...STANDARD_UMSCHLAG, tarif: "niedrigpreis", preis_grenze_cents: 2000,
  stufen: [{ max_weight_g: 210, fee_eur: 2.12 }, { max_weight_g: 460, fee_eur: 2.28 }],
};

/** Vanejas Kinder-Warnweste 2er Set zu ihrem echten Preis von 9,97 €. */
function warnweste(over: Partial<Produkt> = {}): Produkt {
  return produkt({
    sku: "E9-2MFL-TXNN", groessenklasse: "LargeEnvelope",
    laengste_seite_cm: 26.34, mittlere_seite_cm: 21.69, kuerzeste_seite_cm: 3,
    gewicht_g: 170, einheiten: 1738, preis_cents: 997, fulfilment_cents: 266,
    ...over,
  });
}

Deno.test("Niedrigpreis: ohne hinterlegte S.5-Tabelle wird NICHT auf der Standardtabelle gerechnet", () => {
  const b = pruefeKorridor(warnweste(), [GROSSER_UMSCHLAG, STANDARD_UMSCHLAG]);
  assertEquals(b.status, "nicht_bewertbar");
  // Ohne die Tabelle ist nicht einmal der Tarif sicher: Ob die Klasse ueberhaupt
  // zum Programm gehoert, steht in genau der Tabelle, die fehlt.
  assertEquals(b.tarif, null);
  assertEquals(b.ersparnis_jahr, null); // lieber keine Zahl als eine falsche
  assertEquals(b.grund?.includes("Niedrigpreisversand"), true);
});

Deno.test("Niedrigpreis: mit S.5-Tabelle wird auf DEREN Beträgen gerechnet", () => {
  const alle = [GROSSER_UMSCHLAG, STANDARD_UMSCHLAG, NP_GROSSER_UMSCHLAG, NP_STANDARD_UMSCHLAG];
  const b = pruefeKorridor(warnweste(), alle);
  assertEquals(b.status, "chance");
  assertEquals(b.tarif, "niedrigpreis");
  assertEquals(b.ziel_klasse, "StandardEnvelope");
  // Drei Unterschiede zur Standardtabelle auf einmal:
  //   * die Betraege stammen aus S. 5 (2,65 statt 3,04),
  //   * gerechnet wird mit 170 g Stueckgewicht statt 343 g Volumengewicht — damit
  //     greift die Stufe bis 210 g (2,12) und nicht die bis 460 g (2,28),
  //   * kein Treibstoffaufschlag.
  // 2,65 - 2,12 = 0,53.
  assertEquals(b.ersparnis_je_stueck, 0.53);
});

Deno.test("Niedrigpreis: guenstiger Artikel in einer nicht abgedeckten Klasse bleibt Standard", () => {
  // Der Niedrigpreisversand deckt nur die kleinen Klassen ab (S. 5). Echter Fall
  // Vaneja: Geschenktueten 14,97 € im Standardpaket treffen die STANDARD-Tabelle
  // auf den Cent — sie sind fuer das Programm nicht qualifiziert.
  const alle = [...KLASSEN, NP_GROSSER_UMSCHLAG, NP_STANDARD_UMSCHLAG];
  const b = pruefeKorridor(produkt({ preis_cents: 1497 }), alle);
  assertEquals(b.tarif, "standard");
  assertEquals(b.status, "chance");
  assertEquals(b.ersparnis_je_stueck, 1.14); // mit Treibstoffaufschlag
});

Deno.test("Niedrigpreis: teurer Artikel bleibt im Standardtarif", () => {
  const alle = [GROSSER_UMSCHLAG, STANDARD_UMSCHLAG, NP_GROSSER_UMSCHLAG, NP_STANDARD_UMSCHLAG];
  const b = pruefeKorridor(warnweste({ preis_cents: 2997 }), alle);
  assertEquals(b.tarif, "standard");
  assertEquals(b.status, "chance");
  assertEquals(b.ersparnis_je_stueck, 0.37); // 3,04 -> 2,68 + Aufschlag
});

Deno.test("Niedrigpreis: die Grenze kommt aus der Tabelle, nicht aus dem Code", () => {
  assertEquals(niedrigpreisGrenze([GROSSER_UMSCHLAG]), NIEDRIGPREIS_GRENZE_CENTS);
  const eigene = { ...NP_GROSSER_UMSCHLAG, preis_grenze_cents: 1100 };
  assertEquals(niedrigpreisGrenze([GROSSER_UMSCHLAG, eigene]), 1100);
  // 15,97 € liegt ueber einer 11-€-Grenze -> Standardtarif.
  const b = pruefeKorridor(warnweste({ preis_cents: 1597 }), [GROSSER_UMSCHLAG, STANDARD_UMSCHLAG, eigene]);
  assertEquals(b.tarif, "standard");
});

Deno.test("Niedrigpreis: die Tarife werden nicht vermischt", () => {
  // Nur die Standardklassen sind guenstiger — sie duerfen trotzdem nicht als
  // Ziel dienen, denn ein Tarifwechsel ist keine Verpackungsmassnahme.
  const b = pruefeKorridor(warnweste(), [NP_GROSSER_UMSCHLAG, STANDARD_UMSCHLAG]);
  assertEquals(b.tarif, "niedrigpreis");
  assertEquals(b.status, "kleinste_klasse");
  assertEquals(b.ziel_klasse, null);
});

Deno.test("Niedrigpreis: kein Treibstoffaufschlag, im Standardtarif schon", () => {
  assertEquals(aufschlagFuer("standard"), TREIBSTOFF_AUFSCHLAG);
  assertEquals(aufschlagFuer("niedrigpreis"), 1);
});

Deno.test("Niedrigpreis: rechnet nur mit dem Stueckgewicht, nicht mit dem Volumen", () => {
  // 26,34 x 21,69 x 3 = 342,8 g Volumengewicht gegen 170 g Stueckgewicht.
  assertEquals(Math.round(abrechnungsgewicht("standard", 170, 26.34, 21.69, 3)), 343);
  assertEquals(abrechnungsgewicht("niedrigpreis", 170, 26.34, 21.69, 3), 170);
});

Deno.test("Niedrigpreis: ohne Artikelpreis wird nichts behauptet", () => {
  const b = pruefeKorridor(warnweste({ preis_cents: null }), [GROSSER_UMSCHLAG, STANDARD_UMSCHLAG]);
  assertEquals(b.status, "nicht_bewertbar");
  assertEquals(b.tarif, null);
  assertEquals(b.grund?.includes("Artikelpreis"), true);
});

Deno.test("klasseFuerMasse: guenstigste passende Klasse, sonst null", () => {
  // Passt in Kleines Paket (35x25x12), Versandgewicht 30*20*10/5 = 1200 g.
  const k = klasseFuerMasse([30, 20, 10], 800, KLASSEN)!;
  assertEquals(k.klasse.size_tier, "SmallParcel");
  assertEquals(k.gebuehr, 3.41); // Stufe <= 1400 g

  // Reihenfolge der Kanten darf nichts aendern.
  assertEquals(klasseFuerMasse([10, 30, 20], 800, KLASSEN)!.klasse.size_tier, "SmallParcel");

  // Passt nirgends hinein -> null statt Notloesung.
  assertEquals(klasseFuerMasse([200, 100, 90], 800, KLASSEN), null);
});

Deno.test("klasseFuerMasse: bleibt in der Tarifart der zugewiesenen Klasse", () => {
  const kp3: Klasse = {
    size_tier: "SmallParcel3", label: "Kleines Paket 3",
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 12,
    stufen: [], grundgebuehr_eur: 3.38, zuschlag_je_100g_eur: 0.07, max_weight_g: 3900,
  };
  const alle = [...KLASSEN, kp3];
  // Ohne Vorgabe gewinnt die absolut guenstigste.
  assertEquals(klasseFuerMasse([30, 20, 10], 800, alle)!.klasse.size_tier, "SmallParcel");
  // Mit Kategorietarif als Vorgabe bleibt es in der Kategorietabelle.
  assertEquals(klasseFuerMasse([30, 20, 10], 800, alle, kp3)!.klasse.size_tier, "SmallParcel3");
});

Deno.test("korridorReport: sortiert nach Euro und summiert nur echte Chancen", () => {
  const r = korridorReport([
    produkt({ sku: "A", einheiten: 1000 }),
    produkt({ sku: "B", einheiten: 3000 }),
    produkt({ sku: "C", groessenklasse: "MediumParcel2" }), // nicht bewertbar
  ], KLASSEN);
  assertEquals(r.chancen.map((c) => c.sku), ["B", "A"]);
  assertEquals(r.summe_ersparnis_jahr, 1140 + 3420);
  assertEquals(r.nicht_bewertbar, 1);
});

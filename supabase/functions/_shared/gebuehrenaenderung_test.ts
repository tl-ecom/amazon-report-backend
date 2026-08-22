import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bewerteAsin, noetigerNettopreis, simuliere, vergleicheGebuehr, zielmargeAus,
  type AsinErtrag, type GebuehrDelta, type Zielmarge,
} from "./gebuehrenaenderung.ts";
import type { Klasse, Produkt } from "./groessenklassen.ts";

// Werte der Rate Card DE ab 01.07.2026 (Spalte "Nur DE") als Ausgangstabelle.
function standardparket(fee900: number, fee1400: number): Klasse {
  return {
    size_tier: "StandardParcel", label: "Standardpaket",
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: 45, max_median_side_cm: 34, max_shortest_side_cm: 26,
    stufen: [
      { max_weight_g: 400, fee_eur: 3.42 },
      { max_weight_g: 900, fee_eur: fee900 },
      { max_weight_g: 1400, fee_eur: fee1400 },
    ],
    grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 1400,
  };
}
function kleinesPaket(fee: number): Klasse {
  return {
    size_tier: "SmallParcel", label: "Kleines Paket",
    tarif: "standard", preis_grenze_cents: null,
    max_longest_side_cm: 35, max_median_side_cm: 25, max_shortest_side_cm: 12,
    stufen: [{ max_weight_g: 1400, fee_eur: fee }],
    grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 1400,
  };
}
/** Niedrigpreisversand: gleiche Klassennamen, eigene Beträge, eigene Preisgrenze. */
function niedrigpreis(fee900: number, grenzeCents: number | null): Klasse {
  return {
    size_tier: "StandardParcel", label: "Standardpaket (Niedrigpreis)",
    tarif: "niedrigpreis", preis_grenze_cents: grenzeCents,
    max_longest_side_cm: 45, max_median_side_cm: 34, max_shortest_side_cm: 26,
    stufen: [{ max_weight_g: 900, fee_eur: fee900 }],
    grundgebuehr_eur: null, zuschlag_je_100g_eur: null, max_weight_g: 900,
  };
}

const ALT = [standardparket(3.44, 3.93), kleinesPaket(3.40)];
const NEU = [standardparket(3.74, 4.23), kleinesPaket(3.40)];

// Flach genug, dass das Volumengewicht (40x30x5 = 1.200 g) die Gewichtsstufe
// bestimmt, und zu lang fürs kleine Paket — sonst wechselte schon die
// Ausgangstabelle die Klasse.
function produkt(over: Partial<Produkt> = {}): Produkt {
  return {
    sku: "TEST-1", asin: "B0TEST", produktname: "Testprodukt",
    laengste_seite_cm: 40, mittlere_seite_cm: 30, kuerzeste_seite_cm: 5,
    gewicht_g: 800, groessenklasse: "StandardParcel", produktgruppe: "Automotive",
    preis_cents: 2997, fulfilment_cents: 399, einheiten: 1000, fenster_tage: 365,
    ...over,
  };
}

// --- Schritt 1: der Gebührenunterschied je SKU ---

Deno.test("vergleicheGebuehr: Unterschied enthält den Treibstoffaufschlag", () => {
  const d = vergleicheGebuehr(produkt(), ALT, NEU);
  // Stufe 1400 (Volumengewicht 1.200 g): 3,93 -> 4,23 laut Tabelle, beides x 1,015.
  assertEquals(d.gebuehr_alt, 3.99);
  assertEquals(d.gebuehr_neu, 4.29);
  assertEquals(d.delta_je_stueck, 0.3);
  assertEquals(d.grund, null);
});

Deno.test("vergleicheGebuehr: Jahreswert aus dem Absatz, kürzeres Fenster wird hochgerechnet", () => {
  const ganz = vergleicheGebuehr(produkt({ einheiten: 1000, fenster_tage: 365 }), ALT, NEU);
  assertEquals(ganz.delta_jahr, 300);
  assertEquals(ganz.hochgerechnet, false);

  const halb = vergleicheGebuehr(produkt({ einheiten: 500, fenster_tage: 182 }), ALT, NEU);
  assertEquals(halb.hochgerechnet, true);
  // 0,30 x 500 x (365/182) = 300,8 -> 301
  assertEquals(halb.delta_jahr, 301);
});

Deno.test("vergleicheGebuehr: ohne Absatz kein Jahreswert (nicht 0)", () => {
  const d = vergleicheGebuehr(produkt({ einheiten: 0 }), ALT, NEU);
  assertEquals(d.delta_je_stueck, 0.3);
  assertEquals(d.delta_jahr, null);
});

Deno.test("vergleicheGebuehr: fehlende Maße -> Grund statt Zahl", () => {
  const d = vergleicheGebuehr(produkt({ gewicht_g: null }), ALT, NEU);
  assertEquals(d.delta_je_stueck, null);
  assert(d.grund!.includes("Maße"));
});

Deno.test("vergleicheGebuehr: ohne Artikelpreis ist der Tarif nicht entscheidbar", () => {
  const d = vergleicheGebuehr(produkt({ preis_cents: null }), ALT, NEU);
  assertEquals(d.delta_je_stueck, null);
  assert(d.grund!.includes("Artikelpreis"));
});

Deno.test("vergleicheGebuehr: Niedrigpreisversand rechnet ohne Volumengewicht", () => {
  // Sperriges, leichtes Paket: Volumengewicht 1.100 g, Stückgewicht 300 g.
  // Auf der Standardtabelle zählte das Volumengewicht (Stufe 1400), beim
  // Niedrigpreisversand nur das Stückgewicht (Stufe 900).
  const alt = [...ALT, niedrigpreis(2.5, 2000)];
  const neu = [...NEU, niedrigpreis(2.9, 2000)];
  const p = produkt({
    preis_cents: 1499, gewicht_g: 300,
    laengste_seite_cm: 44, mittlere_seite_cm: 25, kuerzeste_seite_cm: 10,
  });
  const d = vergleicheGebuehr(p, alt, neu);
  assertEquals(d.tarif_alt, "niedrigpreis");
  assertEquals(d.gebuehr_alt, 2.54); // 2,50 x 1,015
  assertEquals(d.gebuehr_neu, 2.94); // 2,90 x 1,015
  assertEquals(d.delta_je_stueck, 0.4);
});

Deno.test("vergleicheGebuehr: eine höhere Preisgrenze allein kippt den Tarif", () => {
  // Das Produkt ändert sich nicht — nur die neue Rate Card zieht die Grenze des
  // Niedrigpreisversands von 20 auf 25 EUR hoch. Damit fällt ein 22-EUR-Artikel
  // erstmals darunter.
  const alt = [...ALT, niedrigpreis(2.5, 2000)];
  const neu = [...NEU, niedrigpreis(2.9, 2500)];
  const d = vergleicheGebuehr(produkt({ preis_cents: 2200 }), alt, neu);
  assertEquals(d.tarif_alt, "standard");
  assertEquals(d.tarif_neu, "niedrigpreis");
  assertEquals(d.gebuehr_alt, 3.99);
  assertEquals(d.gebuehr_neu, 2.94);
  assert(d.delta_je_stueck! < 0, "der Tarifwechsel macht es günstiger");
});

Deno.test("vergleicheGebuehr: verschobene Klassengrenze wird als Klassenwechsel gemeldet", () => {
  // Die neue Karte macht das kleine Paket geräumiger — dasselbe Produkt fällt
  // dort erstmals hinein.
  const grosseresKleinpaket: Klasse = { ...kleinesPaket(3.4), max_longest_side_cm: 45, max_median_side_cm: 34, max_shortest_side_cm: 26 };
  const d = vergleicheGebuehr(produkt(), ALT, [standardparket(3.74, 4.23), grosseresKleinpaket]);
  assertEquals(d.klassenwechsel, true);
});

Deno.test("vergleicheGebuehr: weicht die alte Tabelle von der gebuchten Gebühr ab, ist die Prognose unsicher", () => {
  const passt = vergleicheGebuehr(produkt({ fulfilment_cents: 399 }), ALT, NEU);
  assertEquals(passt.tabelle_passt, true);
  const passtNicht = vergleicheGebuehr(produkt({ fulfilment_cents: 512 }), ALT, NEU);
  assertEquals(passtNicht.tabelle_passt, false);
  // Der Unterschied wird trotzdem berechnet — aber als unsicher markiert.
  assertEquals(passtNicht.delta_je_stueck, 0.3);
});

// --- Woher die Zielmarge kommt ---

Deno.test("zielmargeAus: ASIN sticht Rolle sticht Firma", () => {
  assertEquals(zielmargeAus({ min: 25, max: null }, { min: 18, max: null }, 12, "scale").quelle, "asin");
  assertEquals(zielmargeAus({ min: 25, max: null }, { min: 18, max: null }, 12, "scale").prozent, 25);
  assertEquals(zielmargeAus(null, { min: 18, max: null }, 12, "scale").quelle, "rolle");
  assertEquals(zielmargeAus(null, null, 12, "scale").quelle, "firma");
  assertEquals(zielmargeAus(null, null, 12, "scale").prozent, 12);
});

Deno.test("zielmargeAus: nichts hinterlegt -> leer, keine Hausnummer", () => {
  const z = zielmargeAus(null, null, null, "hold");
  assertEquals(z.prozent, null);
  assertEquals(z.quelle, "leer");
});

Deno.test("zielmargeAus: eine reine Obergrenze ist keine Zielmarge", () => {
  // Ein Korridor kann nur ein Maximum nennen (z. B. ACoS). Als Untergrenze für
  // die Marge taugt der nicht — dann greift die nächste Stufe.
  assertEquals(zielmargeAus({ min: null, max: 30 }, null, 15, "scale").quelle, "firma");
});

// --- Der nötige Preis ---

Deno.test("noetigerNettopreis: rechnet die mitsteigende Verkaufsgebühr ein", () => {
  // fix 16,50 EUR, Verkaufsgebühr 15 % vom Nettopreis, Ziel 20 %.
  const p = noetigerNettopreis(16.5, 0.15, 20)!;
  assertEquals(p, 25.39); // 16,50 / 0,65 = 25,3846 -> aufgerundet
  // Gegenprobe: bei diesem Preis wird die Zielmarge wirklich erreicht.
  const db = p - 16.5 - 0.15 * p;
  assert(db / p >= 0.20, `Zielmarge verfehlt: ${(db / p) * 100} %`);
});

Deno.test("noetigerNettopreis: wer die Verkaufsgebühr vergisst, nennt einen zu kleinen Preis", () => {
  const ohne = 16.5 / 0.8; // naiv: fix / (1 - Zielmarge)
  const mit = noetigerNettopreis(16.5, 0.15, 20)!;
  assert(mit > ohne, "die Gebührenquote muss den nötigen Preis heben");
});

Deno.test("noetigerNettopreis: unerreichbare Zielmarge -> null statt Fantasiepreis", () => {
  // 15 % Verkaufsgebühr + 90 % Zielmarge lassen keinen Preis übrig.
  assertEquals(noetigerNettopreis(16.5, 0.15, 90), null);
});

// --- Schritt 2: die ASIN gegen ihre Zielmarge ---

function delta(over: Partial<GebuehrDelta> = {}): GebuehrDelta {
  return {
    sku: "TEST-1", asin: "B0TEST", produktname: "Testprodukt",
    tarif_alt: "standard", tarif_neu: "standard",
    klasse: "StandardParcel", klasse_neu: null, klassenwechsel: false,
    gebuehr_alt: 4, gebuehr_neu: 4.5, delta_je_stueck: 0.5,
    einheiten: 1000, fenster_tage: 365, delta_jahr: 500,
    hochgerechnet: false, tabelle_passt: true, grund: null,
    ...over,
  };
}
/** 1.000 Stück, 25 EUR netto je Stück, 15 % Verkaufsgebühr, 4 EUR FBA. */
function ertrag(over: Partial<AsinErtrag> = {}): AsinErtrag {
  return {
    asin: "B0TEST", produktname: "Testprodukt", einheiten: 1000,
    umsatz_netto: 25000, wareneinsatz: 12000,
    fba_gebuehr: -4000, verkaufsgebuehr: -3750, sonstige_gebuehren: 0,
    ...over,
  };
}
const ZIEL_20: Zielmarge = { prozent: 20, quelle: "rolle", rolle: "scale" };
const OPTS = { umsatzsteuerProzent: 19, niedrigpreisGrenzeCents: 2000 };

Deno.test("bewerteAsin: fällt unter die Zielmarge — mit Lücke und nötigem Preis", () => {
  const b = bewerteAsin([delta()], ertrag(), ZIEL_20, OPTS);
  assertEquals(b.status, "unter_ziel");
  // 25 - 12 - 4 - 3,75 = 5,25 -> 21,0 %
  assertEquals(b.marge_jetzt, 21);
  // nach der Änderung 4,75 -> 19,0 %
  assertEquals(b.marge_nachher, 19);
  assertEquals(b.luecke, 1);
  assertEquals(b.preis_brutto, 29.75);
  assertEquals(b.noetiger_preis_brutto, 30.21); // 25,39 x 1,19
  assertEquals(b.preis_erhoehung_brutto, 0.46);
});

Deno.test("bewerteAsin: der genannte Preis hält die Zielmarge auch nach", () => {
  const b = bewerteAsin([delta()], ertrag(), ZIEL_20, OPTS);
  const netto = b.noetiger_preis_brutto! / 1.19;
  const fix = 12 + 4 + 0.5; // EK + FBA neu + sonstige
  const db = netto - fix - 0.15 * netto;
  assert(db / netto >= 0.20, `Zielmarge verfehlt: ${(db / netto) * 100} %`);
});

Deno.test("bewerteAsin: hält die Marge -> Puffer ist der noch tragbare Werbeanteil", () => {
  const b = bewerteAsin([delta()], ertrag({ wareneinsatz: 5000 }), ZIEL_20, OPTS);
  assertEquals(b.status, "im_ziel_ohne_werbung");
  // 25 - 5 - 4,5 - 3,75 = 11,75 -> 47,0 %; Ziel 20 % -> 27,0 Punkte Luft.
  assertEquals(b.marge_nachher, 47);
  assertEquals(b.puffer, 27);
  assertEquals(b.luecke, null);
});

Deno.test("bewerteAsin: ohne Einkaufspreis keine Marge, aber der Unterschied bleibt", () => {
  const b = bewerteAsin([delta()], ertrag({ wareneinsatz: null }), ZIEL_20, OPTS);
  assertEquals(b.status, "kein_ek");
  assertEquals(b.marge_jetzt, null);
  assertEquals(b.delta_jahr, 500);
});

Deno.test("bewerteAsin: ohne Zielmarge wird nichts behauptet", () => {
  const b = bewerteAsin([delta()], ertrag(), { prozent: null, quelle: "leer", rolle: "scale" }, OPTS);
  assertEquals(b.status, "kein_ziel");
  assertEquals(b.marge_nachher, 19);
  assert(b.grund!.includes("scale"));
});

Deno.test("bewerteAsin: ohne gebuchte Gebühren keine Stückrechnung", () => {
  const b = bewerteAsin([delta()], ertrag({ fba_gebuehr: null }), ZIEL_20, OPTS);
  assertEquals(b.status, "nicht_bewertbar");
  assert(b.grund!.includes("Gebühren"));
});

Deno.test("bewerteAsin: mehrere SKUs werden nach verkaufter Menge gewichtet", () => {
  const b = bewerteAsin([
    delta({ sku: "A", delta_je_stueck: 0.2, einheiten: 900, delta_jahr: 180 }),
    delta({ sku: "B", delta_je_stueck: 1.2, einheiten: 100, delta_jahr: 120 }),
  ], ertrag(), ZIEL_20, OPTS);
  // (0,2 x 900 + 1,2 x 100) / 1000 = 0,30
  assertEquals(b.delta_je_stueck, 0.3);
  assertEquals(b.delta_jahr, 300);
  assertEquals(b.skus, 2);
});

Deno.test("bewerteAsin: SKUs ohne Wert werden gezählt, nicht als 0 mitgemittelt", () => {
  const b = bewerteAsin([
    delta({ sku: "A", delta_je_stueck: 0.5, einheiten: 1000, delta_jahr: 500 }),
    delta({ sku: "B", delta_je_stueck: null, delta_jahr: null, grund: "keine Maße" }),
  ], ertrag(), ZIEL_20, OPTS);
  assertEquals(b.delta_je_stueck, 0.5);
  assertEquals(b.skus_ohne_wert, 1);
});

Deno.test("bewerteAsin: nötige Erhöhung über die Preisgrenze wird als Tarifwechsel gewarnt", () => {
  // 19,00 EUR brutto -> Niedrigpreisversand. Der nötige Preis liegt darüber.
  const b = bewerteAsin(
    [delta({ delta_je_stueck: 0.3, delta_jahr: 300 })],
    ertrag({ umsatz_netto: 15966, wareneinsatz: 8000, fba_gebuehr: -3000, verkaufsgebuehr: -2395 }),
    ZIEL_20, OPTS,
  );
  assertEquals(b.status, "unter_ziel");
  assert(b.noetiger_preis_brutto! >= 20);
  assertEquals(b.tarifwechsel_bei_erhoehung, true);
});

Deno.test("bewerteAsin: kein Umsatz im Zeitraum -> nicht bewertbar, Unterschied bleibt sichtbar", () => {
  const b = bewerteAsin([delta()], null, ZIEL_20, OPTS);
  assertEquals(b.status, "nicht_bewertbar");
  assertEquals(b.delta_je_stueck, 0.5);
  assert(b.grund!.includes("Umsatz"));
});

// --- Der ganze Lauf ---

Deno.test("simuliere: Mehrkosten und Entlastung werden nicht gegeneinander verrechnet", () => {
  const teurer = produkt({ sku: "T-1", asin: "B0TEUER", einheiten: 1000 });
  // Kleines Paket bleibt gleich teuer -> kein Unterschied; wir bauen die
  // Entlastung über eine neue Tabelle, die diese Klasse senkt.
  const guenstiger = produkt({
    sku: "G-1", asin: "B0GUENSTIG", einheiten: 1000,
    groessenklasse: "SmallParcel",
    laengste_seite_cm: 30, mittlere_seite_cm: 20, kuerzeste_seite_cm: 10,
  });
  const neu = [standardparket(3.74, 4.23), kleinesPaket(2.4)];

  const r = simuliere({
    produkte: [teurer, guenstiger],
    klassenAlt: ALT, klassenNeu: neu,
    ertraege: [], ziele: new Map(), umsatzsteuerProzent: 19,
  });
  assertEquals(r.anzahl_produkte, 2);
  assertEquals(r.mehrkosten_jahr, 300);
  assertEquals(r.entlastung_jahr, -1010);
});

Deno.test("simuliere: sortiert nach Jahresbetrag, Teuerstes zuerst", () => {
  const klein = produkt({ sku: "K", asin: "B0KLEIN", einheiten: 100 });
  const gross = produkt({ sku: "G", asin: "B0GROSS", einheiten: 5000 });
  const r = simuliere({
    produkte: [klein, gross], klassenAlt: ALT, klassenNeu: NEU,
    ertraege: [], ziele: new Map(), umsatzsteuerProzent: 19,
  });
  assertEquals(r.befunde[0].asin, "B0GROSS");
  assertEquals(r.befunde[0].delta_jahr, 1500);
});

Deno.test("simuliere: trennt „Unterschied unbekannt“ von „Marge nicht bewertbar“", () => {
  const r = simuliere({
    produkte: [produkt(), produkt({ sku: "X", asin: "B0OHNE", gewicht_g: null })],
    klassenAlt: ALT, klassenNeu: NEU,
    ertraege: [], ziele: new Map(), umsatzsteuerProzent: 19,
  });
  assertEquals(r.anzahl_produkte, 2);
  // Einer hat keine Maße -> kein Gebührenunterschied.
  assertEquals(r.anzahl_mit_unterschied, 1);
  assertEquals(r.anzahl_ohne_unterschied, 1);
  // Umsatzdaten fehlen für beide -> für beide keine Stückrechnung.
  assertEquals(r.anzahl_ohne_stueckrechnung, 2);
});

Deno.test("simuliere: bekannter Unterschied ohne Zielmarge bleibt sichtbar", () => {
  const r = simuliere({
    produkte: [produkt()],
    klassenAlt: ALT, klassenNeu: NEU,
    ertraege: [ertrag()], ziele: new Map(), umsatzsteuerProzent: 19,
  });
  assertEquals(r.anzahl_ohne_ziel, 1);
  assertEquals(r.mehrkosten_jahr, 300);
});

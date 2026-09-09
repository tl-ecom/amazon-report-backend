import { assertEquals } from "jsr:@std/assert@1";
import {
  packungsgroesse, pruefeGebuehren, type GebuehrProdukt,
} from "./gebuehren_pruefung.ts";

// Echte Zahlen aus dem Fall vom 09.09.2026: Vaneja, B0H516MYPV,
// "VANEJA Trennspray Grill 3 x 200 ml", August 2026.
//
// Bruttoumsatz 1.558,68 EUR bei 68 Einheiten. Die Referenz aus Amazons eigener
// Auswertung: Verkaufsgebuehr 233,69, FBA 229,14, Lager 6,33, Gutschriften
// +114,30, Amazon-Gebuehren netto 354,86.
const UMSATZ_BRUTTO = 1558.68;
const UMSATZ_NETTO = 1309.82;
const EINHEITEN = 68;

function produkt(over: Partial<GebuehrProdukt> = {}): GebuehrProdukt {
  return {
    asin: "B0H516MYPV",
    produktname: "VANEJA Trennspray Grill 3 x 200 ml",
    einheiten: EINHEITEN,
    umsatz_brutto: UMSATZ_BRUTTO,
    umsatz: UMSATZ_NETTO,
    verkaufsgebuehr: -233.69,
    fba_gebuehr: -229.14,
    gebuehren: -354.86,
    gebuehren_abdeckung: 1,
    ...over,
  };
}

Deno.test("Referenzfall B0H516MYPV August: keine Beanstandung", () => {
  assertEquals(pruefeGebuehren([produkt()]), []);
});

Deno.test("Regression: der alte Fehlstand wird beanstandet", () => {
  // Genau die Zahlen, die Pulse vor dem Fix auswies. 398,43 / 1.558,68 = 25,6 %.
  const befunde = pruefeGebuehren([produkt({
    verkaufsgebuehr: -398.43, fba_gebuehr: -434.12, gebuehren: -840.78,
  })]);
  const arten = befunde.map((b) => b.art).sort();
  assertEquals(arten, ["gebuehrenquote_hoch", "verkaufsgebuehr_hoch"]);
  // 840,78 / 1.309,82 = 64,2 % vom Nettoumsatz.
  assertEquals(befunde.find((b) => b.art === "gebuehrenquote_hoch")?.wert, 64.2);
  assertEquals(befunde.find((b) => b.art === "verkaufsgebuehr_hoch")?.wert, 25.6);
});

Deno.test("Verkaufsgebuehr: 15 % ist normal, 21 % nicht", () => {
  assertEquals(pruefeGebuehren([produkt({ verkaufsgebuehr: -233.80 })]).length, 0);
  const zuHoch = pruefeGebuehren([produkt({ verkaufsgebuehr: -330 })]);
  assertEquals(zuHoch.some((b) => b.art === "verkaufsgebuehr_hoch"), true);
});

Deno.test("Unvollstaendige Periode wird als solche gemeldet, nicht als guenstig", () => {
  // Der Fall vom September: 2 Einheiten, 1,17 EUR Gebuehr je Stueck. Ohne diesen
  // Befund liest sich das wie ein besonders profitables Produkt.
  const befunde = pruefeGebuehren([produkt({
    einheiten: 2, umsatz_brutto: 45.84, umsatz: 38.52,
    verkaufsgebuehr: -1.5, fba_gebuehr: -0.84, gebuehren: -2.34,
    gebuehren_abdeckung: 0.15,
  })]);
  assertEquals(befunde.some((b) => b.art === "unvollstaendig"), true);
  assertEquals(befunde.find((b) => b.art === "unvollstaendig")?.wert, 15);
});

Deno.test("Packungsgroesse wird aus dem Namen gelesen", () => {
  assertEquals(packungsgroesse("VANEJA Trennspray Grill 3 x 200 ml"), 3);
  assertEquals(packungsgroesse("Trennspray 2 × 200 ml"), 2);
  assertEquals(packungsgroesse("VANEJA Kratzbrett Katze XXL 70 cm"), null);
  assertEquals(packungsgroesse(null), null);
});

Deno.test("Kleinere Packung darf nicht teurer versendet werden als groessere", () => {
  const zweier = produkt({
    asin: "B0AAA", produktname: "Trennspray Grill 2 x 200 ml",
    einheiten: 10, fba_gebuehr: -50, // 5,00 je Stueck
  });
  const dreier = produkt({
    asin: "B0BBB", produktname: "Trennspray Grill 3 x 200 ml",
    einheiten: 10, fba_gebuehr: -40, // 4,00 je Stueck
  });
  const befunde = pruefeGebuehren([zweier, dreier]);
  const b = befunde.find((x) => x.art === "bundle_unplausibel");
  assertEquals(b?.asin, "B0AAA");
  assertEquals(b?.wert, 1.25);
});

Deno.test("Kleine Unterschiede zwischen Packungsgroessen sind kein Befund", () => {
  // Amazons Groessenklassen sind grob gestuft; 5 % Unterschied ist normal.
  const befunde = pruefeGebuehren([
    produkt({ asin: "B0AAA", produktname: "Spray 2 x 200 ml", einheiten: 10, fba_gebuehr: -42 }),
    produkt({ asin: "B0BBB", produktname: "Spray 3 x 200 ml", einheiten: 10, fba_gebuehr: -40 }),
  ]);
  assertEquals(befunde.filter((b) => b.art === "bundle_unplausibel").length, 0);
});

Deno.test("Ohne Gebuehrendaten wird nichts behauptet", () => {
  assertEquals(pruefeGebuehren([produkt({ gebuehren: null, verkaufsgebuehr: null })]), []);
});

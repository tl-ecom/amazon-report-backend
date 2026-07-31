import { assertEquals } from "jsr:@std/assert@1";
import { csvZeilen, datumIso, ekCents, erkenneTrenner, parseEkCsv } from "./sellerboard.ts";

Deno.test("ekCents: deutsche und englische Zahlformate", () => {
  assertEquals(ekCents("12,34"), 1234);
  assertEquals(ekCents("12.34"), 1234);
  assertEquals(ekCents("1.234,56"), 123456); // Tausenderpunkt + Dezimalkomma
  assertEquals(ekCents("1,234.56"), 123456); // Tausenderkomma + Dezimalpunkt
  assertEquals(ekCents("€ 9,99"), 999);
  assertEquals(ekCents("9"), 900);
});

Deno.test("ekCents: leer/unlesbar -> null, nicht 0", () => {
  assertEquals(ekCents(""), null);
  assertEquals(ekCents(null), null);
  assertEquals(ekCents("k. A."), null);
  assertEquals(ekCents("-"), null);
});

Deno.test("datumIso: ISO, deutsch, US", () => {
  assertEquals(datumIso("2026-07-31"), "2026-07-31");
  assertEquals(datumIso("31.07.2026"), "2026-07-31");
  assertEquals(datumIso("7/31/2026"), "2026-07-31");
  assertEquals(datumIso("irgendwas"), null);
  assertEquals(datumIso(""), null);
});

Deno.test("erkenneTrenner: Semikolon, Komma, Tab", () => {
  assertEquals(erkenneTrenner("a;b;c"), ";");
  assertEquals(erkenneTrenner("a,b,c"), ",");
  assertEquals(erkenneTrenner("a\tb\tc"), "\t");
});

Deno.test("csvZeilen: Anfuehrungszeichen mit Trennzeichen und Zeilenumbruch", () => {
  const z = csvZeilen('a,b\n"Text, mit Komma",2\n"Er sagte ""hallo""",3\n', ",");
  assertEquals(z.length, 3);
  assertEquals(z[1][0], "Text, mit Komma");
  assertEquals(z[2][0], 'Er sagte "hallo"');
});

Deno.test("parseEkCsv: deutscher Sellerboard-Export (Semikolon, Komma-Dezimal)", () => {
  const csv = [
    "SKU;ASIN;Produkt;Einkaufspreis;Gültig ab",
    "ZD-JXX7-EX8P;B0FKNN9CCJ;Obst Etagere;12,50;01.06.2026",
    "CX10036;B0D7D2NMT4;Biomülleimer;4,99;01.06.2026",
  ].join("\n");
  const r = parseEkCsv(csv);
  assertEquals(r.zeilen.length, 2);
  assertEquals(r.erkannt.sku, "SKU");
  assertEquals(r.erkannt.ek, "Einkaufspreis");
  assertEquals(r.erkannt.datum, "Gültig ab");
  assertEquals(r.zeilen[0], { sku: "ZD-JXX7-EX8P", asin: "B0FKNN9CCJ", ek_cents: 1250, gueltig_ab: "2026-06-01" });
  assertEquals(r.zeilen[1].ek_cents, 499);
});

Deno.test("parseEkCsv: englischer Export (Komma, Punkt-Dezimal, ohne Datum)", () => {
  const csv = "sku,asin,Cost\nA-1,B01,10.00\nA-2,B02,3.50\n";
  const r = parseEkCsv(csv);
  assertEquals(r.zeilen.length, 2);
  assertEquals(r.erkannt.ek, "Cost");
  assertEquals(r.erkannt.datum, null);
  assertEquals(r.zeilen[0].gueltig_ab, null); // Aufrufer setzt den Default
  assertEquals(r.warnungen.some((w) => w.includes("Datumsspalte")), true);
});

Deno.test("parseEkCsv: nur ASIN, keine SKU -> funktioniert trotzdem", () => {
  const r = parseEkCsv("ASIN;Einkaufspreis\nB0X;7,77\n");
  assertEquals(r.zeilen.length, 1);
  assertEquals(r.zeilen[0].asin, "B0X");
  assertEquals(r.zeilen[0].sku, null);
});

Deno.test("parseEkCsv: Zeilen ohne Preis oder ohne Kennung werden uebersprungen", () => {
  const csv = "SKU;Einkaufspreis\nA-1;12,00\nA-2;\n;5,00\nA-4;0\n";
  const r = parseEkCsv(csv);
  assertEquals(r.zeilen.length, 1);
  assertEquals(r.uebersprungen, 3); // leerer Preis, fehlende SKU, Preis 0
});

Deno.test("parseEkCsv: fehlende Preisspalte -> klare Warnung mit Spaltenliste", () => {
  const r = parseEkCsv("SKU;Produktname\nA-1;Dings\n");
  assertEquals(r.zeilen.length, 0);
  assertEquals(r.warnungen[0].includes("Einkaufspreis-Spalte"), true);
  assertEquals(r.warnungen[0].includes("Produktname"), true); // nennt, was da war
});

Deno.test("parseEkCsv: Teiltreffer im Spaltennamen wird erkannt", () => {
  const r = parseEkCsv("Seller SKU;Einkaufspreis netto (EUR)\nA-1;3,00\n");
  assertEquals(r.zeilen.length, 1);
  assertEquals(r.erkannt.ek, "Einkaufspreis netto (EUR)");
});

Deno.test("parseEkCsv: leere Datei / nur Kopfzeile kippt nicht um", () => {
  assertEquals(parseEkCsv("").zeilen.length, 0);
  assertEquals(parseEkCsv("SKU;Einkaufspreis\n").zeilen.length, 0);
  assertEquals(parseEkCsv("   ").warnungen.length > 0, true);
});

Deno.test("parseEkCsv: BOM am Dateianfang stoert nicht", () => {
  const r = parseEkCsv("﻿SKU;Einkaufspreis\nA-1;1,00\n");
  assertEquals(r.erkannt.sku, "SKU");
  assertEquals(r.zeilen.length, 1);
});

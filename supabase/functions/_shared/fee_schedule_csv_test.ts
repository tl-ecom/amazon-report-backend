import { assertEquals } from "jsr:@std/assert@1";
import { gewichtGramm, massCm, parseGebuehrenCsv } from "./fee_schedule_csv.ts";

Deno.test("massCm: Zahl mit/ohne Einheit, unbegrenzt -> null", () => {
  assertEquals(massCm("45"), 45);
  assertEquals(massCm("45 cm"), 45);
  assertEquals(massCm("45,5"), 45.5);
  // Keine Obergrenze ist NICHT die Grenze 0.
  assertEquals(massCm("unbegrenzt"), null);
  assertEquals(massCm("-"), null);
  assertEquals(massCm(""), null);
});

Deno.test("gewichtGramm: kg ist Standard, g nur wenn ausdruecklich", () => {
  assertEquals(gewichtGramm("12"), 12000);
  assertEquals(gewichtGramm("12 kg"), 12000);
  assertEquals(gewichtGramm("0,96 kg"), 960);
  assertEquals(gewichtGramm("500 g"), 500);
  assertEquals(gewichtGramm("500 Gramm"), 500);
  assertEquals(gewichtGramm("unbegrenzt"), null);
});

Deno.test("parseGebuehrenCsv: deutsche Kopfzeile mit Semikolon", () => {
  const csv = [
    "Größenklasse;Max längste Seite;Max mittlere Seite;Max kürzeste Seite;Max Gewicht;Gebühr;Gültig ab",
    "Standard-Umschlag;33 cm;23 cm;2,5 cm;460 g;2,80;01.01.2026",
    "Standard-Paket groß;45 cm;34 cm;26 cm;12 kg;5,90;01.01.2026",
  ].join("\n");
  const r = parseGebuehrenCsv(csv, "2026-01-01");
  assertEquals(r.zeilen.length, 2);
  assertEquals(r.uebersprungen, 0);
  assertEquals(r.zeilen[0].size_tier, "Standard-Umschlag"); // Name UNVERAENDERT
  assertEquals(r.zeilen[0].max_shortest_side_cm, 2.5);
  assertEquals(r.zeilen[0].max_weight_g, 460);
  assertEquals(r.zeilen[0].fee_eur, 2.8);
  assertEquals(r.zeilen[0].gueltig_ab, "2026-01-01");
  assertEquals(r.zeilen[1].max_weight_g, 12000);
  assertEquals(r.zeilen[1].marketplace, "DE"); // Standard, wenn Spalte fehlt
});

Deno.test("parseGebuehrenCsv: englische Kopfzeile mit Komma", () => {
  const csv = [
    "size_tier,max_longest_side,max_weight,fee,valid_from,marketplace",
    "Small envelope,20,100 g,1.90,2026-01-01,de",
  ].join("\n");
  const r = parseGebuehrenCsv(csv, "2000-01-01");
  assertEquals(r.zeilen.length, 1);
  assertEquals(r.zeilen[0].fee_eur, 1.9);
  assertEquals(r.zeilen[0].max_weight_g, 100);
  assertEquals(r.zeilen[0].marketplace, "DE");
  assertEquals(r.zeilen[0].gueltig_ab, "2026-01-01");
});

Deno.test("parseGebuehrenCsv: mehrere Gewichtsstufen je Klasse bleiben erhalten", () => {
  // Amazons Tabelle listet je Klasse mehrere Stufen. Sie duerfen nicht kollabieren.
  const csv = [
    "Größenklasse;Max Gewicht;Gebühr",
    "StandardParcel;250 g;4,01",
    "StandardParcel;500 g;4,52",
    "StandardParcel;unbegrenzt;6,12",
  ].join("\n");
  const r = parseGebuehrenCsv(csv, "2026-01-01");
  assertEquals(r.zeilen.length, 3);
  assertEquals(r.zeilen.map((z) => z.max_weight_g), [250, 500, null]);
  assertEquals(r.zeilen.map((z) => z.fee_eur), [4.01, 4.52, 6.12]);
});

Deno.test("parseGebuehrenCsv: fehlendes Datum faellt auf den Standard zurueck", () => {
  const r = parseGebuehrenCsv("Größenklasse;Gebühr\nStandard;5,90", "2026-04-01");
  assertEquals(r.zeilen[0].gueltig_ab, "2026-04-01");
  assertEquals(r.zeilen[0].max_longest_side_cm, null); // fehlt = unbekannt, nicht 0
});

Deno.test("parseGebuehrenCsv: Zeilen ohne Klasse werden gezaehlt, nicht verschluckt", () => {
  const r = parseGebuehrenCsv("Größenklasse;Gebühr\n;5,90\nStandard;2,80", "2026-01-01");
  assertEquals(r.zeilen.length, 1);
  assertEquals(r.uebersprungen, 1);
  assertEquals(r.warnungen.some((w) => w.includes("übersprungen")), true);
});

Deno.test("parseGebuehrenCsv: ohne Klassenspalte -> klare Warnung, keine Zeilen", () => {
  const r = parseGebuehrenCsv("Foo;Bar\n1;2", "2026-01-01");
  assertEquals(r.zeilen.length, 0);
  assertEquals(r.warnungen.some((w) => w.includes("Größenklasse")), true);
});

Deno.test("parseGebuehrenCsv: leere Datei und Datei ohne Datenzeilen", () => {
  assertEquals(parseGebuehrenCsv("", "2026-01-01").warnungen.length, 1);
  assertEquals(parseGebuehrenCsv("Größenklasse;Gebühr", "2026-01-01").zeilen.length, 0);
});

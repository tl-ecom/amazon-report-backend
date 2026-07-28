// Tests für tsv.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import { dekodiere, entferneSpalten, parseTsv, parseTsvBytes, pruefeFlatFile } from "./tsv.ts";

// --- Zeichensatz: der Grund, warum dekodiere() existiert ---
Deno.test("UTF-8 wird als UTF-8 erkannt", () => {
  const bytes = new TextEncoder().encode("sku\tname\nA1\tGrüße");
  const { text, encoding } = dekodiere(bytes);
  assertEquals(encoding, "utf-8");
  assertEquals(text.includes("Grüße"), true);
});

Deno.test("Windows-1252 mit Umlauten wird nicht als UTF-8 verstuemmelt", () => {
  // "Größe" in Windows-1252: ö = 0xF6, ß = 0xDF. Als UTF-8 ist das ungültig.
  const bytes = new Uint8Array([
    0x73, 0x6b, 0x75, 0x09, 0x6e, 0x61, 0x6d, 0x65, 0x0a, // "sku\tname\n"
    0x41, 0x31, 0x09, // "A1\t"
    0x47, 0x72, 0xf6, 0xdf, 0x65, // "Größe" in Windows-1252
  ]);
  const { text, encoding } = dekodiere(bytes);
  assertEquals(encoding, "windows-1252");
  assertEquals(text.includes("Größe"), true);
  // Entscheidend: KEIN Ersatzzeichen. Genau das passiert bei stur-UTF-8.
  assertEquals(text.includes("�"), false);
});

Deno.test("Windows-1252 Euro-Zeichen (0x80) wird korrekt dekodiert", () => {
  // 0x80 ist in ISO-8859-1 undefiniert, in Windows-1252 das Euro-Zeichen.
  const bytes = new Uint8Array([0x70, 0x72, 0x65, 0x69, 0x73, 0x0a, 0x80]); // "preis\n€"
  const { text, encoding } = dekodiere(bytes);
  assertEquals(encoding, "windows-1252");
  assertEquals(text.includes("€"), true);
});

Deno.test("parseTsvBytes verbindet Dekodierung und Parsen", () => {
  const bytes = new Uint8Array([
    0x73, 0x6b, 0x75, 0x09, 0x6e, 0x61, 0x6d, 0x65, 0x0a, // "sku\tname\n"
    0x41, 0x31, 0x09, 0x47, 0x72, 0xf6, 0xdf, 0x65, // "A1\tGröße"
  ]);
  const e = parseTsvBytes(bytes);
  assertEquals(e.encoding, "windows-1252");
  assertEquals(e.rows[0].name, "Größe");
});

// --- Parsen ---
Deno.test("Kopfzeile und Zeilen werden zu Objekten", () => {
  const e = parseTsv("amazon-order-id\tsku\tquantity\n028-123\tABC\t2\n028-456\tDEF\t1");
  assertEquals(e.header, ["amazon-order-id", "sku", "quantity"]);
  assertEquals(e.rowCount, 2);
  assertEquals(e.rows[0], { "amazon-order-id": "028-123", sku: "ABC", quantity: "2" });
  assertEquals(e.rows[1]["sku"], "DEF");
});

Deno.test("CRLF-Zeilenenden werden verstanden", () => {
  const e = parseTsv("a\tb\r\n1\t2\r\n3\t4\r\n");
  assertEquals(e.rowCount, 2);
  assertEquals(e.rows[1], { a: "3", b: "4" });
});

Deno.test("abschliessende Leerzeile erzeugt keine Geisterzeile", () => {
  const e = parseTsv("a\tb\n1\t2\n");
  assertEquals(e.rowCount, 1);
});

Deno.test("mehrere Leerzeilen zwischendrin werden uebersprungen", () => {
  const e = parseTsv("a\tb\n1\t2\n\n\n3\t4\n\n");
  assertEquals(e.rowCount, 2);
});

Deno.test("fehlende Felder am Zeilenende werden zu leeren Strings", () => {
  // Amazon lässt optionale Spalten am Ende gern weg.
  const e = parseTsv("a\tb\tc\n1\t2");
  assertEquals(e.rows[0], { a: "1", b: "2", c: "" });
});

Deno.test("leere Felder bleiben leere Strings, nicht undefined", () => {
  const e = parseTsv("a\tb\tc\n1\t\t3");
  assertEquals(e.rows[0], { a: "1", b: "", c: "3" });
});

Deno.test("Werte werden getrimmt", () => {
  const e = parseTsv("a\tb\n  1  \t 2 ");
  assertEquals(e.rows[0], { a: "1", b: "2" });
});

Deno.test("nur eine Kopfzeile ohne Daten ergibt 0 Zeilen", () => {
  const e = parseTsv("a\tb\tc");
  assertEquals(e.header, ["a", "b", "c"]);
  assertEquals(e.rowCount, 0);
  assertEquals(e.rows, []);
});

Deno.test("leerer Text kippt nicht um", () => {
  const e = parseTsv("");
  assertEquals(e.header, []);
  assertEquals(e.rowCount, 0);
});

Deno.test("nur Leerzeilen kippen nicht um", () => {
  const e = parseTsv("\n\n\n");
  assertEquals(e.header, []);
  assertEquals(e.rowCount, 0);
});

Deno.test("fuehrende Leerzeilen vor dem Header werden uebersprungen", () => {
  const e = parseTsv("\n\na\tb\n1\t2");
  assertEquals(e.header, ["a", "b"]);
  assertEquals(e.rowCount, 1);
});

// --- Realistischer Ausschnitt ---
Deno.test("realistischer Orders-Ausschnitt wird korrekt zerlegt", () => {
  const text = [
    "amazon-order-id\tpurchase-date\torder-status\tsku\tasin\tquantity\tcurrency\titem-price",
    "028-1234567-8901234\t2026-06-17T10:23:11+00:00\tShipped\tMEIN-SKU-1\tB0DNT2FDN9\t1\tEUR\t8.05",
    "028-9999999-8888888\t2026-06-18T08:00:00+00:00\tCancelled\tMEIN-SKU-2\tB00CD2X6QS\t0\tEUR\t0.00",
  ].join("\n");

  const e = parseTsv(text);
  assertEquals(e.rowCount, 2);
  assertEquals(e.rows[0]["asin"], "B0DNT2FDN9");
  assertEquals(e.rows[0]["item-price"], "8.05");
  assertEquals(e.rows[1]["order-status"], "Cancelled");
  // Preise bleiben bewusst Strings — Umrechnung gehört in einen eigenen Schritt,
  // damit hier nichts stillschweigend zu Zahlen gerundet wird.
  assertEquals(typeof e.rows[0]["item-price"], "string");
});

// --- Datenminimierung (DSGVO) ---
Deno.test("personenbezogene Spalten werden restlos entfernt", () => {
  const e = parseTsv(
    "amazon-order-id\tship-city\tship-postal-code\tship-country\tasin\n" +
      "028-123\tMörfelden-Walldorf\t64546\tDE\tB09JSHP49L"
  );
  const g = entferneSpalten(e, ["ship-city", "ship-state", "ship-postal-code"]);

  assertEquals(g.header, ["amazon-order-id", "ship-country", "asin"]);
  assertEquals(g.rows[0], { "amazon-order-id": "028-123", "ship-country": "DE", asin: "B09JSHP49L" });

  // Entscheidend: die Werte dürfen nirgends mehr auftauchen — auch nicht als
  // Restfeld in der Zeile.
  assertEquals(JSON.stringify(g).includes("Mörfelden"), false);
  assertEquals(JSON.stringify(g).includes("64546"), false);
  // Das Land bleibt erhalten.
  assertEquals(g.rows[0]["ship-country"], "DE");
});

Deno.test("entfernte Spalten werden dokumentiert", () => {
  const e = parseTsv("a\tship-city\tb\n1\tBerlin\t2");
  const g = entferneSpalten(e, ["ship-city", "ship-postal-code"]);
  // Nur was wirklich da war, wird gemeldet — nicht die ganze Wunschliste.
  assertEquals(g.entfernteSpalten, ["ship-city"]);
});

Deno.test("nicht vorhandene Spalten fuehren nicht zum Fehler", () => {
  // Amazon ändert die Flat-File-Spalten gelegentlich.
  const e = parseTsv("a\tb\n1\t2");
  const g = entferneSpalten(e, ["ship-city", "gibts-nicht"]);
  assertEquals(g.header, ["a", "b"]);
  assertEquals(g.rowCount, 1);
  assertEquals(g.entfernteSpalten, undefined);
});

Deno.test("leere Entfernliste laesst alles unveraendert", () => {
  const e = parseTsv("a\tb\n1\t2");
  assertEquals(entferneSpalten(e, []), e);
});

Deno.test("Zeilenzahl und Zeichensatz ueberleben das Entfernen", () => {
  const e = parseTsv("a\tship-city\n1\tX\n2\tY\n3\tZ", "windows-1252");
  const g = entferneSpalten(e, ["ship-city"]);
  assertEquals(g.rowCount, 3);
  assertEquals(g.encoding, "windows-1252");
  assertEquals(g.format, "tsv");
});

// --- Plausibilitaet: Amazon liefert Fehler ALS Report-Inhalt ---
Deno.test("Amazons Fehlermeldung im Report wird als Nicht-Flat-File erkannt", () => {
  // WORTWÖRTLICH das, was Amazon am 2026-07-17 auf einen 90-Tage-Orders-Report
  // geliefert hat — mit processingStatus DONE und HTTP 200.
  const e = parseTsv("Date range exceeded. Report can be requested only upto 30 days");
  const p = pruefeFlatFile(e);

  assertEquals(p.ok, false);
  if (!p.ok) {
    assertEquals(p.grund.includes("Date range exceeded"), true);
    assertEquals(p.grund.includes("nur eine Spalte"), true);
  }
});

Deno.test("leeres Dokument wird erkannt", () => {
  const p = pruefeFlatFile(parseTsv(""));
  assertEquals(p.ok, false);
  if (!p.ok) assertEquals(p.grund.includes("Leeres Dokument"), true);
});

Deno.test("echtes Flat-File besteht die Pruefung", () => {
  const e = parseTsv("amazon-order-id\tsku\tquantity\n028-123\tABC\t2");
  assertEquals(pruefeFlatFile(e).ok, true);
});

Deno.test("Flat-File mit Kopfzeile aber ohne Datenzeilen ist gueltig", () => {
  // Ein Zeitraum ganz ohne Bestellungen ist kein Fehler — Kopfzeile reicht.
  const e = parseTsv("amazon-order-id\tsku\tquantity");
  assertEquals(pruefeFlatFile(e).ok, true);
  assertEquals(e.rowCount, 0);
});

Deno.test("zweispaltiges Minimal-Flat-File gilt als gueltig", () => {
  assertEquals(pruefeFlatFile(parseTsv("a\tb")).ok, true);
});

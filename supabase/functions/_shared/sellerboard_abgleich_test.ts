// Tests für sellerboard_abgleich.ts.
//
// Die CSV-Zeile ist Vanejas echter August-Export, gekürzt auf die Spalten, die
// verglichen werden. Die Pulse-Werte daneben sind die tatsächlich gemessenen —
// so prüft der Test nicht nur das Rechnen, sondern auch, dass der Abgleich den
// realen Fall richtig bewertet.

import { assertEquals } from "jsr:@std/assert@1";
import {
  csvZeile, guvSpalteZuMonat, leseSellerboard, leseSellerboardDatei,
  leseSellerboardGuv, vergleiche, zuCents, zusammenfassung,
} from "./sellerboard_abgleich.ts";

const CSV = [
  '"DateFrom","DateTo","SalesOrganic","SalesPPC","UnitsOrganic","UnitsPPC",'
  + '"SponsoredProducts","SponsoredDisplay","SponsoredBrands","SponsoredBrandsVideo",'
  + '"Commission","FBAPerUnitFulfillmentFee","FBAStorageFee","VAT",'
  + '"EstimatedPayout","ProductCost Sales","DHL Kosten 19,11 pro Paket x 2"',
  '"01.08.2026","31.08.2026","39163,33","24928,50","1239","1279",'
  + '"-9866,17","-30,31","-1312,90","-376,79",'
  + '"-9241,78","-10226,00","-564,72","-9940,19",'
  + '"29456,32","-14044,38","38,22"',
].join("\r\n");

Deno.test("CSV: deutsche Zahlen und Kommas in Spaltennamen", () => {
  const felder = csvZeile('"a","1.234,56","DHL Kosten 19,11 pro Paket x 2"');
  // Das Komma IN den Anführungszeichen darf nicht trennen — sonst verrutscht
  // die ganze Zeile, und Sellerboard benennt Kostenarten frei.
  assertEquals(felder, ["a", "1.234,56", "DHL Kosten 19,11 pro Paket x 2"]);
  assertEquals(zuCents("1.234,56"), 123456);
  assertEquals(zuCents("-9866,17"), -986617);
});

Deno.test("CSV: leere Felder ergeben null, nicht 0", () => {
  assertEquals(zuCents(""), null);
  assertEquals(zuCents("-"), null);
  assertEquals(zuCents(undefined), null);
  assertEquals(zuCents("0,00"), 0);
});

Deno.test("Sellerboard: Vanejas August wird korrekt gelesen", () => {
  const m = leseSellerboard(CSV)[0];
  assertEquals(m.monat, "2026-08");
  // 39.163,33 + 24.928,50 = 64.091,83 — der Wert aus dem Dashboard.
  assertEquals(m.umsatz_cents, 6409183);
  assertEquals(m.einheiten, 2518);
  // Vier Werbe-Spalten zusammen: -11.586,17.
  assertEquals(m.werbung_cents, -1158617);
  assertEquals(m.ust_cents, -994019);
  assertEquals(m.auszahlung_cents, 2945632);
  assertEquals(m.wareneinsatz_cents, -1404438);
});

Deno.test("Sellerboard: unbekannte Kostenarten stören nicht", () => {
  // "DHL Kosten 19,11 pro Paket x 2" ist eine frei benannte Spalte des
  // Verkäufers. Sie darf weder die Zerlegung noch die Summen beeinflussen.
  const m = leseSellerboard(CSV)[0];
  assertEquals(m.gebuehren_cents, -9241_78 - 10226_00 - 564_72);
});

Deno.test("Abgleich: Umsatz und Einheiten stimmen, Quote nicht", () => {
  const sb = leseSellerboard(CSV)[0];
  const befunde = vergleiche({
    monat: "2026-08",
    umsatz_cents: 6366278,      // Pulse: 63.662,78
    einheiten: 2523,
    werbung_cents: -949355,     // Pulse zählt nach Werbedatum
    gebuehren_cents: -1553765,  // im August erst zur Hälfte abgerechnet
    ust_cents: -939366,
  }, sb);

  const nach = (k: string) => befunde.find((b) => b.kennzahl === k)!;
  // 63.662 gegen 64.092 — 0,7 %, das ist in Ordnung.
  assertEquals(nach("umsatz").bewertung, "ok");
  assertEquals(nach("einheiten").bewertung, "ok");
  // Die Gebühren laufen auseinander, weil Pulse den August erst zur Hälfte
  // abgerechnet hat. Genau das soll der Abgleich melden.
  assertEquals(nach("gebuehren").bewertung, "stark");
  assertEquals(nach("gebuehren").hinweis?.includes("bitte prüfen"), true);
});

Deno.test("Abgleich: fehlende Werte gelten als ungeprüft, nicht als bestanden", () => {
  const sb = leseSellerboard(CSV)[0];
  const befunde = vergleiche({
    monat: "2026-08", umsatz_cents: null, einheiten: null,
    werbung_cents: null, gebuehren_cents: null, ust_cents: null,
  }, sb);
  assertEquals(befunde.every((b) => b.bewertung === "nicht_pruefbar"), true);
  assertEquals(befunde[0].hinweis?.includes("kein Entwarnungssignal"), true);
});

Deno.test("Zusammenfassung: nur starke Abweichungen wecken jemanden", () => {
  const leicht = zusammenfassung("2026-08", [
    { kennzahl: "umsatz", pulse_cents: 100, sellerboard_cents: 106,
      abweichung_prozent: -5.7, bewertung: "abweichung", hinweis: "x" },
  ]);
  // Eine 6-Prozent-Abweichung ist erklärungsbedürftig, aber kein Alarm —
  // wer täglich Mails über Rundungsunterschiede bekommt, liest keine mehr.
  assertEquals(leicht, null);

  const stark = zusammenfassung("2026-08", [
    { kennzahl: "gebuehren", pulse_cents: 100, sellerboard_cents: 200,
      abweichung_prozent: -50, bewertung: "stark", hinweis: "x" },
  ]);
  assertEquals(stark?.includes("gebuehren -50 %"), true);
  assertEquals(stark?.includes("welche stimmt"), true);
});

// --- GuV-Export (transponiertes Format) -------------------------------------
//
// Ausschnitt aus Vanejas echtem 12-Monats-Download. Kennzahlen als Zeilen,
// Monate als Spalten — genau umgekehrt zum Automation-Link.

const GUV = [
  "Parameter/Datum,1.-10. September 2026,August 2026,Juli 2026,Gesamt",
  'Umsatz,"16233,46","64091,83","56874,46",534756',
  '    Organisch,"10833,46","39163,33","34490,94","329627,28"',
  "Einheiten,621,2518,2289,19628",
  '    Organisch,356,1239,1070,9620',
  'Werbekosten,"-3092,68","-11584,7","-10713,29","-99591,36"',
  '    Sponsored Products,"-2775,6","-9865,46","-8966,06","-85192,78"',
  'Amazon-Gebühren,"-6405,81","-21074,62","-19251,12","-178580,49"',
  '    FBA-Gebühr,"-2708,24",-10226,"-9276,01","-83648,18"',
  'Einkaufspreis,"-3534,76","-14454,43","-13673,84","-114200,35"',
  'Umsatzsteuer,"-2534,97","-9940,19","-8769,33","-80650,23"',
  'Erwartete Auszahlung,"6399,99","29457,79","25092,17","227607,67"',
].join("\r\n");

Deno.test("GuV: Monate aus der Kopfzeile, Teilmonat und Gesamt raus", () => {
  assertEquals(guvSpalteZuMonat("August 2026"), "2026-08");
  assertEquals(guvSpalteZuMonat("Juli 2026"), "2026-07");
  assertEquals(guvSpalteZuMonat("März 2026"), "2026-03");
  // Der angebrochene Monat waere unfertig, "Gesamt" summiert ein Jahr —
  // beide wuerden die Pruefung verfaelschen.
  assertEquals(guvSpalteZuMonat("1.-10. September 2026"), null);
  assertEquals(guvSpalteZuMonat("Gesamt"), null);
});

Deno.test("GuV: Vanejas Juli und August korrekt gelesen", () => {
  const m = leseSellerboardGuv(GUV);
  // Absteigend sortiert, ohne Teilmonat und ohne Gesamt.
  assertEquals(m.map((x) => x.monat), ["2026-08", "2026-07"]);

  const juli = m[1];
  assertEquals(juli.umsatz_cents, 5687446);
  assertEquals(juli.einheiten, 2289);
  assertEquals(juli.werbung_cents, -1071329);
  assertEquals(juli.gebuehren_cents, -1925112);
  assertEquals(juli.ust_cents, -876933);
  assertEquals(juli.wareneinsatz_cents, -1367384);
  assertEquals(juli.auszahlung_cents, 2509217);
});

Deno.test("GuV: eingerückte Unterposten werden übersprungen", () => {
  // "    Organisch" und "    FBA-Gebuehr" sind in den Hauptposten enthalten.
  // Sie mitzuzaehlen wuerde jede Summe verdoppeln.
  const m = leseSellerboardGuv(GUV);
  assertEquals(m[0].umsatz_cents, 6409183);
  assertEquals(m[0].gebuehren_cents, -2107462);
});

Deno.test("Format wird selbst erkannt", () => {
  // Der GuV-Export beginnt mit "Parameter/Datum", der Automation-Link mit
  // "DateFrom". Wer die Datei hochlaedt, soll nicht auch noch das Format
  // angeben muessen.
  assertEquals(leseSellerboardDatei(GUV).length, 2);
  assertEquals(leseSellerboardDatei(CSV)[0].monat, "2026-08");
  assertEquals(leseSellerboardDatei("irgendwas\nohne,struktur"), []);
});

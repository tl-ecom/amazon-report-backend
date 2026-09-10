// Tests für sellerboard_abgleich.ts.
//
// Die CSV-Zeile ist Vanejas echter August-Export, gekürzt auf die Spalten, die
// verglichen werden. Die Pulse-Werte daneben sind die tatsächlich gemessenen —
// so prüft der Test nicht nur das Rechnen, sondern auch, dass der Abgleich den
// realen Fall richtig bewertet.

import { assertEquals } from "jsr:@std/assert@1";
import {
  csvZeile, leseSellerboard, vergleiche, zuCents, zusammenfassung,
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

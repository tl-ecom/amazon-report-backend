import { assertEquals } from "jsr:@std/assert@1";
import { messeUstFaktor, nettoGebuehr, type Paar } from "./ust_faktor.ts";

/** Baut Paare mit einem Zielfaktor und optionalem Rauschen je Position. */
function paare(netto: number[], faktoren: number[]): Paar[] {
  return netto.map((n, i) => ({
    sku: `SKU-${i}`,
    netto_cents: n,
    brutto_cents: Math.round(n * faktoren[i]),
  }));
}

Deno.test("messeUstFaktor: erkennt 19 % aus echten Vaneja-Werten", () => {
  // Gebucht vs. Gebuehrenvorschau, gemessen am Abrechnungsbericht 2026-07-31.
  const r = messeUstFaktor([
    { sku: "FG-QCPT-6UX5", brutto_cents: 614, netto_cents: 516 },
    { sku: "89-7JIS-G3KR", brutto_cents: 425, netto_cents: 357 },
    { sku: "82-1P8O-L45X", brutto_cents: 254, netto_cents: 213 },
    { sku: "TE-LJOR-WM12", brutto_cents: 426, netto_cents: 358 },
    { sku: "E9-2MFL-TXNN", brutto_cents: 316, netto_cents: 266 },
    { sku: "VK-3N93-PSVV", brutto_cents: 273, netto_cents: 229 },
  ]);
  assertEquals(r.brauchbar, true);
  assertEquals(r.faktor, 1.19);
  assertEquals(r.prozent, 19);
  assertEquals(r.entspricht, "19 % (Deutschland)");
  assertEquals(r.produkte, 6);
});

Deno.test("messeUstFaktor: ein Vielverkaeufer mit Aufschlag kippt die Messung nicht", () => {
  // Der echte Fall Vaneja: BIO001 stellte 173 von 872 Buchungen bei 1,239.
  // Buchungsgewichtet faellt die Einigkeit unter die Schwelle, produktgewichtet
  // ist es ein Ausreisser unter vielen.
  const p: Paar[] = [];
  for (let i = 0; i < 173; i++) p.push({ sku: "BIO001", brutto_cents: 1239, netto_cents: 1000 });
  for (const sku of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"]) {
    p.push({ sku, brutto_cents: 1190, netto_cents: 1000 });
  }
  const r = messeUstFaktor(p);
  assertEquals(r.brauchbar, true);
  assertEquals(r.vorschlag, 1.19);
  assertEquals(r.produkte, 15);
  assertEquals(r.ausreisser.length, 1);
  assertEquals(r.ausreisser[0].sku, "BIO001");
});

Deno.test("messeUstFaktor: Messung nahe am Gesetzessatz -> exakter Satz vorgeschlagen", () => {
  // 1,1905 gemessen heisst 19 %, nicht 19,05 % — ein Steuersatz ist exakt.
  const p = ["A", "B", "C", "D", "E"].map((sku) => ({
    sku, brutto_cents: 11905, netto_cents: 10000,
  }));
  const r = messeUstFaktor(p);
  assertEquals(r.faktor, 1.191); // was gemessen wurde
  assertEquals(r.vorschlag, 1.19); // was übernommen werden soll
  assertEquals(r.prozent, 19);
});

Deno.test("messeUstFaktor: Reverse Charge -> Faktor 1,0 und klarer Text", () => {
  const r = messeUstFaktor(paare([516, 357, 213, 358, 266, 229], [1, 1, 1, 1, 1, 1]));
  assertEquals(r.brauchbar, true);
  assertEquals(r.faktor, 1);
  assertEquals(r.prozent, 0);
  assertEquals(r.begruendung.includes("praktisch keine Umsatzsteuer"), true);
});

Deno.test("messeUstFaktor: zu wenig Daten -> nicht bestimmbar, nie geraten", () => {
  const r = messeUstFaktor([
    { sku: "A", brutto_cents: 614, netto_cents: 516 },
    { sku: "B", brutto_cents: 425, netto_cents: 357 },
  ]);
  assertEquals(r.faktor, null);
  assertEquals(r.brauchbar, false);
  assertEquals(r.begruendung.includes("Zu wenig"), true);
});

Deno.test("messeUstFaktor: viele Buchungen, aber nur zwei Produkte -> zu duenn", () => {
  const p: Paar[] = [];
  for (let i = 0; i < 20; i++) {
    p.push({ sku: i % 2 ? "A" : "B", brutto_cents: 614, netto_cents: 516 });
  }
  const r = messeUstFaktor(p);
  assertEquals(r.brauchbar, false);
  assertEquals(r.produkte, 2);
});

Deno.test("messeUstFaktor: starke Streuung -> lieber nichts sagen", () => {
  const r = messeUstFaktor(paare(
    [500, 500, 500, 500, 500, 500],
    [1.19, 1.02, 1.27, 1.05, 1.24, 1.10],
  ));
  assertEquals(r.faktor, null);
  assertEquals(r.brauchbar, false);
  assertEquals(r.begruendung.includes("streuen"), true);
  assertEquals(r.spanne !== null, true); // Belege trotzdem zeigen
});

Deno.test("messeUstFaktor: einzelne Ausreisser kippen den Median nicht", () => {
  const r = messeUstFaktor(paare(
    [500, 500, 500, 500, 500, 500, 500, 500, 500, 500],
    [1.19, 1.19, 1.19, 1.19, 1.19, 1.19, 1.19, 1.19, 1.19, 1.55],
  ));
  assertEquals(r.brauchbar, true);
  assertEquals(r.faktor, 1.19);
  assertEquals(r.einigkeit, 0.9);
});

Deno.test("messeUstFaktor: unplausibler Wert wird nicht als Steuersatz verkauft", () => {
  const r = messeUstFaktor(paare([500, 500, 500, 500, 500, 500], [1.8, 1.8, 1.8, 1.8, 1.8, 1.8]));
  assertEquals(r.faktor, null);
  assertEquals(r.begruendung.includes("ausserhalb"), true);
});

Deno.test("messeUstFaktor: kaputte Paare werden verworfen, nicht mitgerechnet", () => {
  const r = messeUstFaktor([
    { sku: "A", brutto_cents: 614, netto_cents: 0 },      // Division durch 0
    { sku: "B", brutto_cents: -425, netto_cents: 357 },   // negativ
    { sku: "C", brutto_cents: NaN, netto_cents: 213 },
  ]);
  assertEquals(r.paare, 0);
  assertEquals(r.faktor, null);
});

Deno.test("nettoGebuehr: ohne bestaetigten Faktor bleibt der Betrag unveraendert", () => {
  assertEquals(nettoGebuehr(1190, null), 1190);
  assertEquals(nettoGebuehr(1190, 1.19), 1000);
  assertEquals(nettoGebuehr(1190, 1), 1190);
  // Unplausible Faktoren duerfen nichts umrechnen.
  assertEquals(nettoGebuehr(1190, 2), 1190);
  assertEquals(nettoGebuehr(1190, NaN), 1190);
});

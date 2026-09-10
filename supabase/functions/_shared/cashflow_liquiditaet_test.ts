// Tests für cashflow_liquiditaet.ts.
//
// Die Fixture bildet Vanejas Kalender nach: Auszahlung alle 14 Tage um die
// 8.000 €, Lagergebühr am 7., Werbung wöchentlich, Umsatzsteuer am 10. Mit
// einem Startwert von 12.000 € kippt der Verlauf genau dann, wenn die
// Umsatzsteuer vor der nächsten Auszahlung liegt — der Fall, wegen dem es
// diese Rechnung überhaupt gibt.

import { assertEquals } from "jsr:@std/assert@1";
import {
  liquiditaetsverlauf, VERALTET_MAX_TAGE, type LiquiditaetsPosition,
} from "./cashflow_liquiditaet.ts";

const HEUTE = new Date("2026-09-10T09:00:00Z");

const POSITIONEN: LiquiditaetsPosition[] = [
  { am: "2026-09-13", art: "werbung", bezeichnung: "Werbekosten (4 Tage)", betrag: -1547.4 },
  { am: "2026-09-24", art: "auszahlung", bezeichnung: "Auszahlung", betrag: 8021.0 },
  { am: "2026-10-07", art: "lagergebuehr", bezeichnung: "Lagergebühr", betrag: -548.21 },
  { am: "2026-10-08", art: "auszahlung", bezeichnung: "Auszahlung", betrag: 8021.0 },
  { am: "2026-10-10", art: "umsatzsteuer", bezeichnung: "Umsatzsteuer-Voranmeldung", betrag: -5450.5 },
];

Deno.test("Liquidität: ohne Kontostand wird kein Verlauf erfunden", () => {
  const l = liquiditaetsverlauf(POSITIONEN, null, null, null, HEUTE);
  // Ein Verlauf ab 0 € sähe aus wie eine Rechnung und wäre eine Erfindung.
  assertEquals(l.verlauf, []);
  assertEquals(l.tiefpunkt, null);
  assertEquals(l.hinweise[0].includes("Kein Kontostand hinterlegt"), true);
});

Deno.test("Liquidität: Verlauf ab dem gemeldeten Stand", () => {
  const l = liquiditaetsverlauf(POSITIONEN, 12000, "2026-09-10", null, HEUTE);
  assertEquals(l.start, 12000);
  assertEquals(l.veraltet_tage, 0);
  assertEquals(l.verlauf.map((t) => t.am), [
    "2026-09-13", "2026-09-24", "2026-10-07", "2026-10-08", "2026-10-10",
  ]);
  // 12.000 − 1.547,40 = 10.452,60; + 8.021 = 18.473,60; − 548,21 = 17.925,39;
  // + 8.021 = 25.946,39; − 5.450,50 = 20.495,89.
  assertEquals(l.verlauf.map((t) => t.saldo), [
    10452.6, 18473.6, 17925.39, 25946.39, 20495.89,
  ]);
  assertEquals(l.tiefpunkt, { am: "2026-09-13", saldo: 10452.6 });
  assertEquals(l.unter_null_ab, null);
});

Deno.test("Liquidität: Puffer-Unterschreitung wird benannt", () => {
  const l = liquiditaetsverlauf(POSITIONEN, 12000, "2026-09-10", 11000, HEUTE);
  // Der Puffer ist die Zahl, unter die der Verkäufer nicht will — nicht null.
  assertEquals(l.unter_puffer_ab, "2026-09-13");
  assertEquals(l.unter_null_ab, null);
  assertEquals(l.hinweise.some((h) => h.includes("Puffer von 11000 €")), true);
});

Deno.test("Liquidität: das Minus wird als Zeitproblem benannt, nicht als Verlust", () => {
  const l = liquiditaetsverlauf(POSITIONEN, 1000, "2026-09-10", null, HEUTE);
  assertEquals(l.unter_null_ab, "2026-09-13");
  assertEquals(l.verlauf[0].saldo, -547.4);
  // Der wichtigste Satz der ganzen Datei: ein leeres Konto bei laufendem
  // Umsatz ist kein Gewinnproblem. Wer das verwechselt, kürzt die Werbung.
  assertEquals(l.hinweise.some((h) => h.includes("kein Gewinnproblem")), true);
});

Deno.test("Liquidität: offener Betrag macht die Tage danach unsicher", () => {
  const mitOffen: LiquiditaetsPosition[] = [
    { am: "2026-09-13", art: "werbung", bezeichnung: "Werbekosten", betrag: -1547.4 },
    { am: "2026-09-24", art: "auszahlung", bezeichnung: "Auszahlung", betrag: null },
    { am: "2026-10-07", art: "lagergebuehr", bezeichnung: "Lagergebühr", betrag: -548.21 },
  ];
  const l = liquiditaetsverlauf(mitOffen, 12000, "2026-09-10", null, HEUTE);
  assertEquals(l.offene_posten, 1);
  assertEquals(l.verlauf.map((t) => t.sicher), [true, false, false]);
  // Der offene Posten zählt als 0 — der Saldo ist damit zu niedrig, nicht zu
  // hoch. Das muss dranstehen, sonst liest es sich wie eine Rechnung.
  assertEquals(l.verlauf[2].saldo, 9904.39);
  assertEquals(l.hinweise.some((h) => h.includes("keinen Betrag")), true);
});

Deno.test("Liquidität: veralteter Stand — erst Hinweis, dann gar nichts", () => {
  // Fünf Tage alt: brauchbar, aber kommentiert.
  const jung = liquiditaetsverlauf(POSITIONEN, 12000, "2026-09-05", null, HEUTE);
  assertEquals(jung.veraltet_tage, 5);
  assertEquals(jung.verlauf.length, 5);
  assertEquals(jung.hinweise.some((h) => h.includes("5 Tage alt")), true);

  // Über einen Monat alt: dazwischen liegen zwei Auszahlungen, die niemand
  // kennt. Daraus einen Saldo zu bilden wäre keine Schätzung mehr.
  const alt = liquiditaetsverlauf(POSITIONEN, 12000, "2026-07-01", null, HEUTE);
  assertEquals(alt.verlauf, []);
  assertEquals(alt.hinweise[0].includes("Tage alt"), true);
  assertEquals(71 > VERALTET_MAX_TAGE, true);
});

Deno.test("Liquidität: ein Stand aus der Zukunft wird abgelehnt", () => {
  const l = liquiditaetsverlauf(POSITIONEN, 12000, "2026-09-20", null, HEUTE);
  assertEquals(l.verlauf, []);
  assertEquals(l.hinweise[0].includes("in der Zukunft"), true);
});

Deno.test("Liquidität: Bewegungen vor heute zählen nicht doppelt", () => {
  // Der gemeldete Stand enthält sie bereits. Sie erneut abzuziehen wäre der
  // klassische Doppelzähl-Fehler.
  const mitVergangenheit: LiquiditaetsPosition[] = [
    { am: "2026-09-01", art: "auszahlung", bezeichnung: "Auszahlung", betrag: 8021.0 },
    ...POSITIONEN,
  ];
  const l = liquiditaetsverlauf(mitVergangenheit, 12000, "2026-09-10", null, HEUTE);
  assertEquals(l.verlauf.length, 5);
  assertEquals(l.verlauf[0].saldo, 10452.6);
});

Deno.test("Liquidität: eine Bewegung genau heute gehört in den Verlauf", () => {
  const heuteFaellig: LiquiditaetsPosition[] = [
    { am: "2026-09-10", art: "umsatzsteuer", bezeichnung: "Umsatzsteuer", betrag: -5450.5 },
    ...POSITIONEN,
  ];
  const l = liquiditaetsverlauf(heuteFaellig, 12000, "2026-09-10", null, HEUTE);
  assertEquals(l.verlauf[0], { am: "2026-09-10", bewegung: -5450.5, saldo: 6549.5, sicher: true });
});

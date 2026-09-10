// Tests für cashflow_geldlauf.ts.
//
// Die Fixtures sind die an Vaneja gemessenen Werte: Verteilung mit frühestem
// Eingang nach 11 Tagen und Median 18, Monatsquoten mit Juli bei 47,0 % und
// August bei 60,7 % (letzterer nur, weil dort erst die Hälfte abgerechnet ist).

import { assertEquals } from "jsr:@std/assert@1";
import {
  aufTermine, auszahlungsquote, erwarteteZufluesse, geldlaufMuster,
  vorfinanzierung, type QuoteZeile, type VerteilungZeile,
} from "./cashflow_geldlauf.ts";

// Vanejas echte Monatszahlen, in Cent.
const MONATE: QuoteZeile[] = [
  { monat: "2026-09", umsatz_brutto_cents: 1495979, gebuehren_cents: 0, werbung_cents: 208451, abdeckung: 0.0 },
  { monat: "2026-08", umsatz_brutto_cents: 6366278, gebuehren_cents: -1553765, werbung_cents: 949355, abdeckung: 0.555 },
  { monat: "2026-07", umsatz_brutto_cents: 5662413, gebuehren_cents: -2137720, werbung_cents: 864003, abdeckung: 0.864 },
  { monat: "2026-06", umsatz_brutto_cents: 4880079, gebuehren_cents: -1840453, werbung_cents: 692545, abdeckung: 0.945 },
];

Deno.test("Quote: nur ein abgerechneter Monat taugt als Grundlage", () => {
  const q = auszahlungsquote(MONATE);
  // Juli (86 % abgerechnet), nicht August (55 %) und nicht September (0 %).
  assertEquals(q.monat, "2026-07");
  assertEquals(q.quote, 0.4699);
  assertEquals(q.grund.includes("86 % abgerechnet"), true);
});

Deno.test("Quote: der jüngste unfertige Monat sieht am besten aus", () => {
  // September stünde bei 86 % Quote, weil dort noch KEINE Gebühren gebucht
  // sind. Genau deshalb ist die Abdeckungsschwelle nötig — ohne sie liefert
  // der frischeste Monat immer die schönste und falscheste Zahl.
  const nurSeptember = auszahlungsquote([MONATE[0]]);
  assertEquals(nurSeptember.quote, null);
  assertEquals(nurSeptember.grund.includes("nicht geschätzt"), true);
});

Deno.test("Quote: der jüngste brauchbare Monat gewinnt, kein Mittelwert", () => {
  // Juni läge bei 48,1 %, Juli bei 47,0 %. Ein Mittelwert über Monate würde
  // eine Budgetänderung monatelang nachschleppen.
  const q = auszahlungsquote(MONATE.filter((m) => m.monat <= "2026-07"));
  assertEquals(q.monat, "2026-07");
});

// --- Geldlauf ---------------------------------------------------------------

const VERTEILUNG: VerteilungZeile[] = [
  { tage: 11, bestellungen: 229 }, { tage: 12, bestellungen: 337 },
  { tage: 13, bestellungen: 442 }, { tage: 14, bestellungen: 387 },
  { tage: 15, bestellungen: 394 }, { tage: 16, bestellungen: 436 },
  { tage: 17, bestellungen: 346 }, { tage: 18, bestellungen: 412 },
  { tage: 19, bestellungen: 336 }, { tage: 20, bestellungen: 348 },
  { tage: 21, bestellungen: 334 }, { tage: 22, bestellungen: 305 },
  { tage: 23, bestellungen: 290 }, { tage: 24, bestellungen: 191 },
  { tage: 25, bestellungen: 133 }, { tage: 26, bestellungen: 61 },
];

Deno.test("Geldlauf: Median, frühester Eingang und Sperre erkannt", () => {
  const m = geldlaufMuster(VERTEILUNG);
  assertEquals(m.frueheste_tage, 11);
  assertEquals(m.median_tage, 17);
  assertEquals(m.belege, 4981);
  // Der eigentliche Befund: unter 11 Tagen kommt nichts. Ohne Sperre müsste
  // eine Bestellung kurz vor Periodenende nach zwei Tagen ausgezahlt sein.
  assertEquals(m.sperre_erkennbar, true);
});

Deno.test("Geldlauf: ohne Sperre beginnt die Verteilung früh", () => {
  const m = geldlaufMuster([
    { tage: 2, bestellungen: 100 }, { tage: 5, bestellungen: 200 },
    { tage: 9, bestellungen: 150 }, { tage: 14, bestellungen: 120 },
  ]);
  assertEquals(m.frueheste_tage, 2);
  // Hier wird nichts zurückgehalten — das darf der Code nicht behaupten.
  assertEquals(m.sperre_erkennbar, false);
});

Deno.test("Geldlauf: ohne Daten keine Zahlen", () => {
  const m = geldlaufMuster([]);
  assertEquals(m.median_tage, null);
  assertEquals(m.frueheste_tage, null);
  assertEquals(m.sperre_erkennbar, false);
});

// --- Erwartete Zuflüsse -----------------------------------------------------

Deno.test("Zuflüsse: eine Bestellung verteilt sich über die Laufzeiten", () => {
  // 1.000 € brutto am 01.09., Quote 50 %, Verteilung 40/60 auf 11 und 12 Tage.
  const z = erwarteteZufluesse(
    [{ am: "2026-09-01", brutto_cents: 100000 }],
    geldlaufMuster([{ tage: 11, bestellungen: 40 }, { tage: 12, bestellungen: 60 }]),
    0.5,
  );
  assertEquals(z, [
    { am: "2026-09-12", betrag: 200 },
    { am: "2026-09-13", betrag: 300 },
  ]);
  // Zusammen 500 € — die Hälfte von 1.000, wie die Quote sagt. Der Rest sind
  // Gebühren und Werbung, die gar nicht erst ankommen.
});

Deno.test("Zuflüsse: der Median allein würde alles auf einen Tag stapeln", () => {
  const muster = geldlaufMuster(VERTEILUNG);
  const z = erwarteteZufluesse(
    [{ am: "2026-09-01", brutto_cents: 1000000 }], muster, 0.47,
  );
  // 16 Laufzeiten -> 16 Eingangstage, nicht einer.
  assertEquals(z.length, 16);
  const summe = z.reduce((s, x) => s + x.betrag, 0);
  assertEquals(Math.round(summe), 4700);
});

Deno.test("Zuflüsse: ohne Quote wird nichts geschätzt", () => {
  const z = erwarteteZufluesse(
    [{ am: "2026-09-01", brutto_cents: 100000 }], geldlaufMuster(VERTEILUNG), null,
  );
  assertEquals(z, []);
});

Deno.test("Termine: Geld kommt zum Termin, nicht täglich", () => {
  const zufluesse = [
    { am: "2026-09-11", betrag: 100 },
    { am: "2026-09-12", betrag: 200 },
    { am: "2026-09-25", betrag: 400 },
    { am: "2026-11-01", betrag: 999 }, // hinter dem letzten Termin
  ];
  const t = aufTermine(zufluesse, ["2026-09-24", "2026-09-10", "2026-10-08"]);
  // Der 11. und 12. fallen auf den nächsten Termin danach (24.09.).
  assertEquals(t.get("2026-09-10"), undefined);
  assertEquals(t.get("2026-09-24"), 300);
  assertEquals(t.get("2026-10-08"), 400);
  // Was hinter das Fenster fällt, wird weggelassen statt vorgezogen.
  assertEquals([...t.values()].reduce((s, x) => s + x, 0), 700);
});

// --- Vorfinanzierung --------------------------------------------------------

Deno.test("Vorfinanzierung: der Sockel, der nie zurückkommt", () => {
  const v = vorfinanzierung(18, -386.85);
  assertEquals(v.sockel, 6963.3);
  // Die eigentlich nützliche Zahl für eine Budgetentscheidung.
  assertEquals(v.je_100_euro_mehr, 1800);
});

Deno.test("Vorfinanzierung: ohne Messung keine Zahl", () => {
  assertEquals(vorfinanzierung(null, -386.85).sockel, null);
  assertEquals(vorfinanzierung(18, null).sockel, null);
});

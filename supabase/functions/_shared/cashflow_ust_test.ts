// Tests für cashflow_ust.ts.
//
// Die Zahlen sind die gemessenen Vaneja-Werte für August 2026: 9.082,54 €
// vereinnahmte Steuer auf Amazon.de, 254,86 € auf Amazon.fr, 21.107,59 €
// Bestellgebühren brutto, 257,69 € separat ausgewiesene Vorsteuer.

import { assertEquals } from "jsr:@std/assert@1";
import {
  angemeldeteMonate, marktplatzLand, umsatzsteuerZahllast, zahllastFuerTermin,
  type UstZeile,
} from "./cashflow_ust.ts";

const AUGUST: UstZeile[] = [
  {
    monat: "2026-08", marktplatz: "Amazon.de",
    vereinnahmt_cents: 908254, einbehalten_cents: 0,
    vorsteuer_ausgewiesen_cents: -25769, gebuehren_brutto_cents: -2110759,
  },
  {
    monat: "2026-08", marktplatz: "Amazon.fr",
    vereinnahmt_cents: 25486, einbehalten_cents: 0,
    vorsteuer_ausgewiesen_cents: -299, gebuehren_brutto_cents: -85827,
  },
  {
    monat: "2026-08", marktplatz: "unbekannt",
    vereinnahmt_cents: 5, einbehalten_cents: 0,
    vorsteuer_ausgewiesen_cents: 0, gebuehren_brutto_cents: -1410,
  },
];

const PROFIL = {
  faktor: 1.19, abzugsberechtigt: true, land: "DE",
  rhythmus: "monatlich", dauerfrist: false, oss: true,
};

Deno.test("Zahllast: vereinnahmt minus Vorsteuer, Inland getrennt vom Ausland", () => {
  const u = umsatzsteuerZahllast(AUGUST, PROFIL, new Date("2026-09-09T00:00:00Z"));
  const m = u.monate[0];

  // Inland = Amazon.de + der nicht zuordenbare Rest: 9.082,54 + 0,05.
  assertEquals(m.vereinnahmt, 9082.59);
  // Gebühren brutto inländisch: 21.107,59 + 14,10 = 21.121,69.
  // Steueranteil = 21.121,69 - 21.121,69/1,19 = 3.372,37; plus 257,69 ausgewiesen.
  assertEquals(m.vorsteuer, 3630.06);
  assertEquals(m.zahllast_aus_amazon, 5452.53);

  // Frankreich gehört NICHT in die deutsche Voranmeldung.
  assertEquals(m.ausland, [{ marktplatz: "Amazon.fr", vereinnahmt: 254.86, amazon_abgefuehrt: 0 }]);
  assertEquals(m.ausland_summe, 254.86);
  assertEquals(u.faellig_am, "2026-09-10");
});

Deno.test("Deutscher Regelfall: Amazon führt nichts ab, alles ist eigene Schuld", () => {
  // Anders als in den USA behält Amazon in Deutschland nichts ein — der
  // Verkäufer zahlt selbst. An echten Daten bestätigt: in der gesamten
  // Vaneja-Historie steht auf Amazon.de keine einzige einbehaltene Zeile.
  // Genau deshalb ist die volle vereinnahmte Steuer ein echter Cash-Abfluss
  // und gehört in die Planung.
  const u = umsatzsteuerZahllast(AUGUST, PROFIL);
  assertEquals(u.monate[0].amazon_abgefuehrt, 0);
  assertEquals(u.monate[0].zahllast_aus_amazon, 5452.53);
  // Und es wird auch nichts dazu behauptet, was nicht passiert ist.
  assertEquals(u.hinweise.some((h) => h.includes("selbst einbehalten")), false);
});

Deno.test("Ausland: was Amazon dort abführt, wird getrennt ausgewiesen", () => {
  // Der einzige Einbehalt in den Vaneja-Daten stammt von Amazon.fr — 4,05 €.
  // Er darf die deutsche Zahllast nicht berühren, muss aber bei der
  // OSS-Summe sichtbar sein: dort schuldet der Verkäufer ihn nicht mehr.
  const u = umsatzsteuerZahllast([
    AUGUST[0],
    { ...AUGUST[1], einbehalten_cents: -405 },
  ], PROFIL);

  assertEquals(u.monate[0].amazon_abgefuehrt, 0);
  // Nur Amazon.de im Inland (ohne die nicht zuordenbare Zeile): 9.082,54
  // minus 3.627,81 Vorsteuer.
  assertEquals(u.monate[0].zahllast_aus_amazon, 5454.73);
  assertEquals(u.monate[0].ausland_summe, 254.86);
  assertEquals(u.monate[0].ausland_abgefuehrt, 4.05);
});

Deno.test("Einbehalt im Inland ist in Deutschland erklärungsbedürftig", () => {
  const u = umsatzsteuerZahllast([{
    monat: "2026-08", marktplatz: "Amazon.de",
    vereinnahmt_cents: 100000, einbehalten_cents: -40000,
    vorsteuer_ausgewiesen_cents: 0, gebuehren_brutto_cents: 0,
  }], PROFIL);
  // Der Betrag wird abgezogen, aber nicht wortlos: in DE ist das die Ausnahme.
  assertEquals(u.monate[0].zahllast_aus_amazon, 600);
  assertEquals(u.hinweise.some((h) => h.includes("Ausnahme")), true);
});

Deno.test("Zahllast: was Amazon selbst abführt, mindert die eigene Schuld", () => {
  // Marketplace Facilitator: Amazon behält die Steuer ein und zahlt sie ans
  // Finanzamt. Ohne diesen Abzug würde Pulse eine Schuld ausweisen, die längst
  // beglichen ist.
  const u = umsatzsteuerZahllast([{
    monat: "2026-08", marktplatz: "Amazon.de",
    vereinnahmt_cents: 100000, einbehalten_cents: -40000,
    vorsteuer_ausgewiesen_cents: 0, gebuehren_brutto_cents: 0,
  }], PROFIL);

  assertEquals(u.monate[0].vereinnahmt, 1000);
  assertEquals(u.monate[0].amazon_abgefuehrt, 400);
  assertEquals(u.monate[0].zahllast_aus_amazon, 600);
});

Deno.test("Zahllast: Kleinunternehmer zieht keine Vorsteuer ab", () => {
  const u = umsatzsteuerZahllast(AUGUST, { ...PROFIL, abzugsberechtigt: false });
  assertEquals(u.monate[0].vorsteuer, 0);
  // Ohne Vorsteuerabzug bleibt die volle vereinnahmte Steuer stehen.
  assertEquals(u.monate[0].zahllast_aus_amazon, 9082.59);
});

Deno.test("Zahllast: ohne Steuerfaktor keine Zahl, statt einer geschätzten", () => {
  const u = umsatzsteuerZahllast(AUGUST, { ...PROFIL, faktor: null });
  assertEquals(u.monate[0].vorsteuer, null);
  assertEquals(u.monate[0].zahllast_aus_amazon, null);
  // Die vereinnahmte Seite ist trotzdem bekannt und wird gezeigt.
  assertEquals(u.monate[0].vereinnahmt, 9082.59);
});

Deno.test("Zahllast: der Vorbehalt zur fehlenden Vorsteuer steht immer da", () => {
  const u = umsatzsteuerZahllast(AUGUST, PROFIL);
  // Ohne diesen Satz liest sich die Zahl wie ein Voranmeldungsergebnis.
  assertEquals(u.hinweise[0].includes("NUR mit Amazon-Daten"), true);
  assertEquals(u.hinweise[0].includes("Wareneinkauf"), true);
});

Deno.test("Zahllast: Auslandsumsätze ohne OSS-Angabe werden angemahnt", () => {
  const u = umsatzsteuerZahllast(AUGUST, { ...PROFIL, oss: null });
  assertEquals(u.hinweise.some((h) => h.includes("nicht angegeben")), true);
  const nein = umsatzsteuerZahllast(AUGUST, { ...PROFIL, oss: false });
  assertEquals(nein.hinweise.some((h) => h.includes("auf „nein“ gesetzt")), true);
});

Deno.test("Zahllast: ohne Auslandsumsatz kein OSS-Hinweis", () => {
  const nurDe = AUGUST.filter((z) => z.marktplatz !== "Amazon.fr");
  const u = umsatzsteuerZahllast(nurDe, { ...PROFIL, oss: null });
  assertEquals(u.hinweise.some((h) => h.includes("OSS")), false);
});

Deno.test("marktplatzLand: die längere Endung gewinnt", () => {
  // "amazon.com.be" darf nicht als Deutschland oder als amazon.com durchgehen.
  assertEquals(marktplatzLand("Amazon.com.be"), "BE");
  assertEquals(marktplatzLand("Amazon.de"), "DE");
  assertEquals(marktplatzLand("Amazon.co.uk"), "GB");
  assertEquals(marktplatzLand("Non-Amazon DE"), null);
  assertEquals(marktplatzLand("unbekannt"), null);
});

Deno.test("Inlands- und Auslands-Vorsteuer ergeben zusammen die Gesamtsumme", () => {
  // Aufgefallen beim Lesen der Oberfläche: die Zahllast-Tabelle wies 3.632,09 €
  // Vorsteuer aus, die Vorsteuer-Tabelle darunter 3.775,56 €. Beide Zahlen
  // waren richtig — die eine rechnet inländisch, die andere über alle
  // Marktplätze. Aber beide hießen "Vorsteuer", und die Differenz von 143,47 €
  // musste man selbst herleiten. Jetzt kommt der Auslandsanteil mit heraus,
  // damit die Brücke sichtbar ist.
  const u = umsatzsteuerZahllast(AUGUST, PROFIL);
  const m = u.monate[0];

  assertEquals(m.vorsteuer, 3630.06);
  // 858,27 brutto -> 137,03 Steueranteil, plus 2,99 separat ausgewiesen.
  assertEquals(m.ausland_vorsteuer, 140.02);
  // Die Summe muss der Gesamtsicht entsprechen, sonst stehen wieder zwei
  // Zahlen nebeneinander, die sich nicht verbinden lassen.
  assertEquals(Math.round(((m.vorsteuer ?? 0) + (m.ausland_vorsteuer ?? 0)) * 100) / 100, 3770.08);
});

Deno.test("Ohne Steuerfaktor bleibt auch der Auslandsanteil offen", () => {
  const u = umsatzsteuerZahllast(AUGUST, { ...PROFIL, faktor: null });
  assertEquals(u.monate[0].ausland_vorsteuer, null);
});

Deno.test("Je Marktplatz: getrennt gerechnet, Inland zuerst", () => {
  // Auslandsumsätze zu addieren hilft niemandem — wer in Frankreich meldet,
  // braucht die französische Zahl, nicht die Summe aus vier Ländern.
  const u = umsatzsteuerZahllast(AUGUST, PROFIL);
  const mp = u.monate[0].je_marktplatz;

  assertEquals(mp.map((x) => x.marktplatz), ["Amazon.de", "unbekannt", "Amazon.fr"]);
  // Inland zuerst, danach nach Umsatz absteigend.
  assertEquals(mp.map((x) => x.inland), [true, true, false]);
  assertEquals(mp[0].land, "DE");
  assertEquals(mp[2].land, "FR");

  // Frankreich vollständig durchgerechnet: 254,86 vereinnahmt, 140,02 Vorsteuer.
  assertEquals(mp[2].vereinnahmt, 254.86);
  assertEquals(mp[2].vorsteuer, 140.02);
  assertEquals(mp[2].zahllast_aus_amazon, 114.84);
});

Deno.test("Je Marktplatz: die Summe der Inlandszeilen ergibt die Zahllast", () => {
  // Sonst stünden im selben Bereich zwei Zahlen, die sich widersprechen.
  const m = umsatzsteuerZahllast(AUGUST, PROFIL).monate[0];
  const inland = m.je_marktplatz.filter((x) => x.inland);
  const summe = inland.reduce((s, x) => s + (x.zahllast_aus_amazon ?? 0), 0);
  assertEquals(Math.round(summe * 100) / 100, m.zahllast_aus_amazon);
});

// --- Welcher Zeitraum wird angemeldet? --------------------------------------
//
// Live aufgefallen: der Kalender wies für den 10.09. eine Umsatzsteuer von
// 0,00 € aus. Genommen wurde der jüngste Monat mit Daten — der angebrochene
// September. Angemeldet wird an diesem Termin aber der AUGUST, und dort sind
// 5.450 € fällig. Eine Null an dieser Stelle ist schlimmer als keine Zahl.

Deno.test("Anmeldezeitraum: monatlich meldet den Vormonat", () => {
  assertEquals(angemeldeteMonate("2026-09-10", "monatlich", false), ["2026-08"]);
  // Über den Jahreswechsel.
  assertEquals(angemeldeteMonate("2027-01-10", "monatlich", false), ["2026-12"]);
});

Deno.test("Anmeldezeitraum: Dauerfristverlängerung schiebt einen Monat weiter", () => {
  assertEquals(angemeldeteMonate("2026-10-10", "monatlich", true), ["2026-08"]);
});

Deno.test("Anmeldezeitraum: vierteljährlich meldet drei Monate", () => {
  assertEquals(angemeldeteMonate("2026-10-10", "vierteljaehrlich", false),
    ["2026-07", "2026-08", "2026-09"]);
});

Deno.test("Zahllast zum Termin: nimmt den angemeldeten Monat, nicht den jüngsten", () => {
  const monate = umsatzsteuerZahllast([
    ...AUGUST,
    // Der laufende September, praktisch leer — genau die Falle.
    {
      monat: "2026-09", marktplatz: "Amazon.de", vereinnahmt_cents: 5,
      einbehalten_cents: 0, vorsteuer_ausgewiesen_cents: 0, gebuehren_brutto_cents: 0,
    },
  ], PROFIL).monate;

  const r = zahllastFuerTermin(monate, "2026-09-10", "monatlich", false);
  assertEquals(r.zeitraum, ["2026-08"]);
  assertEquals(r.betrag, 5452.53);
});

Deno.test("Zahllast zum Termin: ohne Daten für den Zeitraum bleibt der Betrag offen", () => {
  const monate = umsatzsteuerZahllast(AUGUST, PROFIL).monate;
  // Für den Juli liegen keine Daten vor.
  const r = zahllastFuerTermin(monate, "2026-08-10", "monatlich", false);
  assertEquals(r.zeitraum, ["2026-07"]);
  assertEquals(r.betrag, null);
});

Deno.test("Zahllast zum Termin: ohne Rhythmus keine Zuordnung", () => {
  const monate = umsatzsteuerZahllast(AUGUST, PROFIL).monate;
  assertEquals(zahllastFuerTermin(monate, "2026-09-10", null, false).betrag, null);
  assertEquals(zahllastFuerTermin(monate, null, "monatlich", false).betrag, null);
});

// --- Quartalsweise Anmeldung ------------------------------------------------
//
// Vaneja meldet quartalsweise. Damit meldet ein Termin DREI Monate, und der
// gefährliche Fall ist nicht ein fehlender Termin, sondern ein fehlender Monat
// darin: die Summe sieht plausibel aus und ist ein Drittel zu niedrig.

Deno.test("Quartal: der Termin am 10.10. meldet Juli bis September", () => {
  assertEquals(
    angemeldeteMonate("2026-10-10", "vierteljaehrlich", false),
    ["2026-07", "2026-08", "2026-09"],
  );
  // Mit Dauerfristverlängerung ist am 10.11. dasselbe Quartal fällig.
  assertEquals(
    angemeldeteMonate("2026-11-10", "vierteljaehrlich", true),
    ["2026-07", "2026-08", "2026-09"],
  );
  // Jahreswechsel: der Januar-Termin meldet das Vorjahresquartal.
  assertEquals(
    angemeldeteMonate("2027-01-10", "vierteljaehrlich", false),
    ["2026-10", "2026-11", "2026-12"],
  );
});

Deno.test("Quartal: alle drei Monate werden summiert", () => {
  const monate = [
    { monat: "2026-07", zahllast_aus_amazon: 5454.73 },
    { monat: "2026-08", zahllast_aus_amazon: 5450.5 },
    { monat: "2026-09", zahllast_aus_amazon: 1820.11 },
  ] as any;
  const z = zahllastFuerTermin(monate, "2026-10-10", "vierteljaehrlich", false);
  assertEquals(z.betrag, 12725.34);
  assertEquals(z.fehlende, []);
});

Deno.test("Quartal: ein fehlender Monat wird benannt, nicht verschwiegen", () => {
  const monate = [
    { monat: "2026-08", zahllast_aus_amazon: 5450.5 },
    { monat: "2026-09", zahllast_aus_amazon: 1820.11 },
  ] as any;
  const z = zahllastFuerTermin(monate, "2026-10-10", "vierteljaehrlich", false);
  // Die Summe steht — aber sie ist um den Juli zu niedrig, und das gehört
  // dazugesagt. Vorher kam hier nur 7.270,61 ohne jeden Vorbehalt heraus.
  assertEquals(z.betrag, 7270.61);
  assertEquals(z.zeitraum, ["2026-07", "2026-08", "2026-09"]);
  assertEquals(z.fehlende, ["2026-07"]);
});

Deno.test("Quartal: kein einziger Monat da — Termin ohne Betrag", () => {
  const z = zahllastFuerTermin([] as any, "2026-10-10", "vierteljaehrlich", false);
  assertEquals(z.betrag, null);
  assertEquals(z.fehlende.length, 3);
});

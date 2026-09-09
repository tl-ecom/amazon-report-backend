// Tests für cashflow.ts.
//
// Die Fixtures sind keine erfundenen Zahlen: sie bilden nach, was bei Vaneja
// tatsächlich gemessen wurde — 14-Tage-Perioden, Schnitt 15:44 UTC, Auszahlung
// exakt 48 Stunden später, Lagergebühr am 7., Werbung an einer Rechnungs-
// schwelle um 596 €. Deshalb prüfen sie nicht nur, dass der Code rechnet,
// sondern dass er die richtige Geschichte erzählt.

import { assertEquals } from "jsr:@std/assert@1";
import {
  auszahlungsRhythmus, gebundenesGeld, median, naechsteAnmeldung,
  reserveStand, terminMuster, vorsteuer, werbungsMuster,
} from "./cashflow.ts";

// --- Auszahlungsrhythmus ----------------------------------------------------

/** Baut eine Abrechnung im gemessenen Muster: 14 Tage, Schnitt 15:44 UTC. */
function abrechnung(bis: string, betrag_cents: number, tageLang = 14) {
  const bisUtc = `${bis}T15:44:25.000Z`;
  const von = new Date(Date.parse(`${bis}T00:00:00Z`) - tageLang * 86400000)
    .toISOString().slice(0, 10);
  const ausUtc = new Date(Date.parse(bisUtc) + 48 * 3600000).toISOString();
  return {
    settlement_id: `s-${bis}`, von, bis,
    auszahlung_am: ausUtc.slice(0, 10),
    betrag_cents, bis_utc: bisUtc, auszahlung_utc: ausUtc,
  };
}

Deno.test("Rhythmus: 14 Tage, 48 Stunden Verzug, Schnitt auf die Minute", () => {
  const r = auszahlungsRhythmus([
    abrechnung("2026-08-11", 79345),
    abrechnung("2026-08-25", 5670),
    abrechnung("2026-07-28", 3361),
    abrechnung("2026-07-14", 82694),
  ], new Date("2026-08-26T10:00:00Z"));

  assertEquals(r.periode_tage, 14);
  assertEquals(r.verzug_stunden, 48);
  // 15:44 UTC ist im August 17:44 deutscher Zeit. Die Uhrzeit ist die
  // eigentliche Antwort auf "wann ist Cutoff" — sie darf nicht verloren gehen.
  assertEquals(r.schnitt_uhrzeit, "17:44");
  assertEquals(r.belege, 4);
});

Deno.test("Rhythmus: die nächste Auszahlung ist gemessen, die danach geschätzt", () => {
  const r = auszahlungsRhythmus([
    abrechnung("2026-09-08", 50000),
    abrechnung("2026-08-25", 60000),
    abrechnung("2026-08-11", 70000),
  ], new Date("2026-09-09T08:00:00Z"));

  // Die Periode bis 08.09. ist gelaufen, die Auszahlung (10.09.) steht noch
  // aus. Sie ist damit bekannt, nicht prognostiziert.
  assertEquals(r.naechste[0].geschaetzt, false);
  assertEquals(r.naechste[0].auszahlung_am.slice(0, 10), "2026-09-10");
  assertEquals(r.naechste[1].geschaetzt, true);
  assertEquals(r.naechste[1].auszahlung_am.slice(0, 10), "2026-09-24");
});

Deno.test("Rhythmus: Sonderperioden verziehen den Median nicht", () => {
  // Bei Vaneja liegt eine Abrechnung über 868 Tage in den Daten. Ein
  // Mittelwert wäre damit unbrauchbar; der Median darf sie ignorieren.
  const r = auszahlungsRhythmus([
    abrechnung("2026-08-11", 79345),
    abrechnung("2026-08-25", 5670),
    abrechnung("2026-07-28", 3361),
    abrechnung("2026-09-01", 100, 868),
  ], new Date("2026-09-02T10:00:00Z"));
  assertEquals(r.periode_tage, 14);
});

Deno.test("Rhythmus: ohne Daten kein Rhythmus (null statt 14)", () => {
  const r = auszahlungsRhythmus([]);
  assertEquals(r.periode_tage, null);
  assertEquals(r.verzug_stunden, null);
  assertEquals(r.naechste.length, 0);
});

Deno.test("Rhythmus: eine einzelne Uhrzeit ist Zufall, keine Aussage", () => {
  const r = auszahlungsRhythmus([
    abrechnung("2026-08-11", 79345),
    { ...abrechnung("2026-08-25", 5670), bis_utc: "2026-08-25T06:20:13.000Z" },
  ], new Date("2026-08-26T10:00:00Z"));
  // Zwei Belege, zwei verschiedene Uhrzeiten -> keine behauptet.
  assertEquals(r.schnitt_uhrzeit, null);
});

// --- Terminbuchungen --------------------------------------------------------

Deno.test("Termine: Lagergebühr am 7., trotz einer Abweichung", () => {
  const m = terminMuster([
    { art: "FBA Inventory Storage Fee", gebucht_am: "2026-06-07", betrag_cents: -53743 },
    { art: "FBA Inventory Storage Fee", gebucht_am: "2026-07-07", betrag_cents: -55900 },
    { art: "FBA Inventory Storage Fee", gebucht_am: "2026-08-07", betrag_cents: -67203 },
    { art: "FBA Long Term Storage Fee", gebucht_am: "2026-07-20", betrag_cents: -2024 },
    { art: "FBA Long Term Storage Fee", gebucht_am: "2026-08-19", betrag_cents: -1529 },
    { art: "FBA Long Term Storage Fee", gebucht_am: "2026-06-20", betrag_cents: -766 },
  ]);
  const lager = m.find((x) => x.art === "FBA Inventory Storage Fee")!;
  assertEquals(lager.tag_im_monat, 7);
  assertEquals(lager.treffer, 3);
  assertEquals(lager.letzter_betrag, -672.03);

  // Der 19. statt 20. ist eine Abweichung von einem Tag — der Termin bleibt.
  const lang = m.find((x) => x.art === "FBA Long Term Storage Fee")!;
  assertEquals(lang.tag_im_monat, 20);
  assertEquals(lang.treffer, 3);
});

Deno.test("Termine: springt der Tag, wird kein Termin behauptet", () => {
  const m = terminMuster([
    { art: "Irgendwas", gebucht_am: "2026-06-03", betrag_cents: -100 },
    { art: "Irgendwas", gebucht_am: "2026-07-17", betrag_cents: -100 },
    { art: "Irgendwas", gebucht_am: "2026-08-28", betrag_cents: -100 },
  ]);
  assertEquals(m[0].tag_im_monat, null);
});

// --- Werbung ----------------------------------------------------------------

Deno.test("Werbung: Rechnungsschwelle wird als solche erkannt", () => {
  // Nachgebaut aus den echten Buchungen: enge Beträge, wechselnde Abstände.
  const zeilen = [
    ["2026-08-01", -59748], ["2026-08-02", -60032], ["2026-08-03", -60032],
    ["2026-08-05", -59505], ["2026-08-06", -59629], ["2026-08-07", -59513],
    ["2026-08-09", -59950], ["2026-08-10", -59731], ["2026-08-11", -60558],
    ["2026-08-13", -59584],
  ].map(([gebucht_am, betrag_cents]) => ({
    gebucht_am: String(gebucht_am), betrag_cents: Number(betrag_cents),
  }));

  const w = werbungsMuster(zeilen);
  assertEquals(w.art, "rechnungsschwelle");
  assertEquals(w.schwelle, 597.4);
  assertEquals(w.abstand_tage_median, 1);
  assertEquals(w.buchungen, 10);
});

Deno.test("Werbung: schwankende Beträge sind keine Schwelle", () => {
  const zeilen = [
    ["2026-08-01", -1000], ["2026-08-08", -45000], ["2026-08-15", -3000],
    ["2026-08-22", -80000], ["2026-08-29", -12000], ["2026-09-05", -60000],
  ].map(([gebucht_am, betrag_cents]) => ({
    gebucht_am: String(gebucht_am), betrag_cents: Number(betrag_cents),
  }));
  assertEquals(werbungsMuster(zeilen).art, "unregelmaessig");
  assertEquals(werbungsMuster(zeilen).schwelle, null);
});

Deno.test("Werbung: vier Buchungen tragen keine Aussage", () => {
  const w = werbungsMuster([
    { gebucht_am: "2026-08-01", betrag_cents: -59748 },
    { gebucht_am: "2026-08-02", betrag_cents: -60032 },
    { gebucht_am: "2026-08-03", betrag_cents: -60032 },
    { gebucht_am: "2026-08-05", betrag_cents: -59505 },
  ]);
  assertEquals(w.art, "zu_wenig_daten");
  assertEquals(w.schwelle, null);
});

// --- Einbehalt --------------------------------------------------------------

Deno.test("Einbehalt: der Stand ist die jüngste Zeile, nicht die Summe", () => {
  const r = reserveStand([
    { gebucht_am: "2026-09-01", art: "Current Reserve Amount", betrag_cents: -9970 },
    { gebucht_am: "2026-08-25", art: "Current Reserve Amount", betrag_cents: -6786 },
    { gebucht_am: "2026-08-11", art: "Current Reserve Amount", betrag_cents: -6786 },
    { gebucht_am: "2026-08-11", art: "Previous Reserve Amount Balance", betrag_cents: 6786 },
  ], 10498.38);

  // Aufsummiert wären es 235,42 € — das wäre falsch: jede Periode gibt den
  // Einbehalt der Vorperiode wieder frei.
  assertEquals(r.stand, 99.7);
  assertEquals(r.stand_am, "2026-09-01");
  assertEquals(r.anteil_prozent, 0.9);
});

Deno.test("Einbehalt: Bezugsgröße ist die typische, nicht die letzte Auszahlung", () => {
  // Live aufgefallen: Vaneja hatte als jüngste Abrechnung eine Verrechnung
  // über 0,29 €. Bezogen darauf ergab der Einbehalt von 99,70 € einen Anteil
  // von 34.379 %. Die Zahl war richtig gerechnet und trotzdem Unsinn — falsche
  // Bezugsgröße. Jetzt zählt die typische Auszahlung.
  const zeilen = [
    { gebucht_am: "2026-09-01", art: "Current Reserve Amount", betrag_cents: -9970 },
  ];
  assertEquals(reserveStand(zeilen, 0.29).anteil_prozent, 34379.3);
  assertEquals(reserveStand(zeilen, 8000).anteil_prozent, 1.2);
});

Deno.test("Einbehalt: kein Einbehalt in den Daten -> null, nicht 0", () => {
  const r = reserveStand([], 5000);
  assertEquals(r.stand, null);
  assertEquals(r.belege, 0);
});

// --- Gebundenes Geld --------------------------------------------------------

Deno.test("Gebundenes Geld: Datenlücke wird nicht als Guthaben gezählt", () => {
  // Die echte Vaneja-Staffel. April ist zu 90 % ohne Abrechnungszeile — das
  // ist der Rand der Historie, kein Geld unterwegs. Die erste Fassung des
  // Codes hat daraus 38.978 € gemacht.
  const g = gebundenesGeld([
    { monat: "2026-04", bestellungen: 1751, offen_anzahl: 1583, offen_cents: 3800000 },
    { monat: "2026-05", bestellungen: 1541, offen_anzahl: 16, offen_cents: 0 },
    { monat: "2026-06", bestellungen: 1782, offen_anzahl: 4, offen_cents: 1049 },
    { monat: "2026-07", bestellungen: 2211, offen_anzahl: 7, offen_cents: 6945 },
    { monat: "2026-08", bestellungen: 2408, offen_anzahl: 785, offen_cents: 2139818 },
    { monat: "2026-09", bestellungen: 491, offen_anzahl: 491, offen_cents: 1327565 },
  ]);

  // 6.945 + 2.139.818 + 1.327.565 Cent, ab dem letzten abgerechneten Monat.
  assertEquals(g.betrag, 34743.28);
  assertEquals(g.ab_monat, "2026-07");
  assertEquals(g.luecken, ["2026-04"]);
  assertEquals(g.hinweis !== null, true);
});

Deno.test("Gebundenes Geld: ohne einen abgerechneten Monat keine Zahl", () => {
  const g = gebundenesGeld([
    { monat: "2026-08", bestellungen: 100, offen_anzahl: 90, offen_cents: 500000 },
    { monat: "2026-09", bestellungen: 50, offen_anzahl: 50, offen_cents: 300000 },
  ]);
  // Lieber keine Zahl als eine, die Lücke und Forderung vermischt.
  assertEquals(g.betrag, null);
  assertEquals(g.luecken.length, 2);
});

// --- Vorsteuer --------------------------------------------------------------

Deno.test("Vorsteuer: ausgewiesen und eingerechnet bleiben getrennt", () => {
  const v = vorsteuer(
    [{ monat: "2026-08", ausgewiesen_cents: -26238, in_gebuehren_cents: -2200359 }],
    { faktor: 1.19, abzugsberechtigt: true, rhythmus: "monatlich", dauerfrist: false },
    new Date("2026-09-09T00:00:00Z"),
  );
  const m = v.monate[0];
  assertEquals(m.ausgewiesen, 262.38);
  // 22.003,59 brutto -> netto 18.490,41; Differenz 3.513,18 ist die Vorsteuer.
  assertEquals(m.aus_gebuehren, 3513.18);
  assertEquals(m.gesamt, 3775.56);
  assertEquals(v.naechste_anmeldung, "2026-09-10");
});

Deno.test("Vorsteuer: ohne bestätigten Faktor bleibt der Anteil offen", () => {
  const v = vorsteuer(
    [{ monat: "2026-08", ausgewiesen_cents: -26238, in_gebuehren_cents: -2200359 }],
    { faktor: null, abzugsberechtigt: true, rhythmus: "monatlich", dauerfrist: false },
  );
  // Der ablesbare Teil steht da, der zu rechnende nicht — statt geschätzt.
  assertEquals(v.monate[0].ausgewiesen, 262.38);
  assertEquals(v.monate[0].aus_gebuehren, null);
  assertEquals(v.hinweise.some((h) => h.includes("Steuerfaktor")), true);
});

Deno.test("Vorsteuer: Kleinunternehmer bekommt nichts zurück, und das steht da", () => {
  const v = vorsteuer(
    [{ monat: "2026-08", ausgewiesen_cents: -26238, in_gebuehren_cents: -2200359 }],
    { faktor: 1.19, abzugsberechtigt: false, rhythmus: null, dauerfrist: null },
  );
  assertEquals(v.abzugsberechtigt, false);
  assertEquals(v.hinweise.some((h) => h.includes("§ 19")), true);
});

// --- Anmeldetermine ---------------------------------------------------------

Deno.test("Voranmeldung: monatlich, mit und ohne Dauerfristverlängerung", () => {
  const heute = new Date("2026-09-09T00:00:00Z");
  assertEquals(naechsteAnmeldung("monatlich", false, heute), "2026-09-10");
  // Dauerfristverlängerung schiebt um einen Monat.
  assertEquals(naechsteAnmeldung("monatlich", true, heute), "2026-10-10");
});

Deno.test("Voranmeldung: vierteljährlich springt auf das Quartalsende", () => {
  const heute = new Date("2026-09-09T00:00:00Z");
  assertEquals(naechsteAnmeldung("vierteljaehrlich", false, heute), "2026-10-10");
});

Deno.test("Voranmeldung: ohne hinterlegten Rhythmus kein Termin", () => {
  assertEquals(naechsteAnmeldung(null, false, new Date("2026-09-09T00:00:00Z")), null);
  assertEquals(naechsteAnmeldung("keine", false, new Date("2026-09-09T00:00:00Z")), null);
});

// --- Baustein ---------------------------------------------------------------

Deno.test("median: gerade und ungerade Anzahl, leer ergibt null", () => {
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([4, 1, 2, 3]), 2.5);
  assertEquals(median([]), null);
});

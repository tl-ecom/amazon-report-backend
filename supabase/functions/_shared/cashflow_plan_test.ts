// Tests für cashflow_plan.ts — den Zahlungskalender.
//
// Die Muster sind die an Vaneja gemessenen: 14-Tage-Rhythmus mit Schnitt
// 15:44 UTC, Lagergebühr am 7., Langzeitlager am 20., Kontogebühr am 16.,
// Werbung als Rechnungsschwelle mit rund 387 € Tagesabfluss.

import { assertEquals } from "jsr:@std/assert@1";
import { zahlungsplan, type PlanEingabe } from "./cashflow_plan.ts";

const HEUTE = new Date("2026-09-10T09:00:00Z");

const EINGABE: PlanEingabe = {
  rhythmus: {
    periode_tage: 14,
    verzug_stunden: 48,
    schnitt_uhrzeit: "17:44",
    belege: 23,
    naechste: [
      { periode_bis: "2026-09-08T15:44:25.000Z", auszahlung_am: "2026-09-10T15:44:25.000Z", geschaetzt: false },
      { periode_bis: "2026-09-22T15:44:25.000Z", auszahlung_am: "2026-09-24T15:44:25.000Z", geschaetzt: true },
      { periode_bis: "2026-10-06T15:44:25.000Z", auszahlung_am: "2026-10-08T15:44:25.000Z", geschaetzt: true },
    ],
  },
  typische_auszahlung: 7934.59,
  termine: [
    {
      art: "FBA Inventory Storage Fee", tag_im_monat: 7, belege: 4, treffer: 4,
      letzte_buchung: "2026-09-07", letzter_betrag: -0.29, schnitt_betrag: -548.21,
    },
    {
      art: "other-transaction", tag_im_monat: 16, belege: 4, treffer: 4,
      letzte_buchung: "2026-08-16", letzter_betrag: -46.41, schnitt_betrag: -46.41,
    },
  ],
  werbung: {
    art: "rechnungsschwelle", schwelle: 597.86, abstand_tage_median: 2,
    buchungen: 70, summe: -42167.01, je_tag: -386.85,
  },
  umsatzsteuer: { faellig_am: "2026-10-10", betrag: 5450.5 },
  tage: 40,
};

Deno.test("Kalender: Auszahlungstermine im Fenster, mit Schätzbetrag", () => {
  const p = zahlungsplan(EINGABE, HEUTE);
  const aus = p.positionen.filter((x) => x.art === "auszahlung");

  assertEquals(aus.map((x) => x.am), ["2026-09-10", "2026-09-24", "2026-10-08"]);
  assertEquals(aus[0].betrag, 7934.59);
  // Auch bei geschlossener Periode ist der BETRAG nie sicher — Amazon sagt
  // vorher nicht, wie viel kommt. Das darf der Kalender nicht behaupten.
  assertEquals(aus[0].sicher, false);
  assertEquals(aus[0].grundlage.includes("nicht der echte"), true);
});

Deno.test("Kalender: Monatstermine wiederholen sich korrekt", () => {
  const p = zahlungsplan(EINGABE, HEUTE);
  // Fenster 10.09.–20.10.: der 7. kommt nur im Oktober noch vor.
  assertEquals(p.positionen.filter((x) => x.art === "lagergebuehr").map((x) => x.am), ["2026-10-07"]);
  // Der 16. kommt in beiden Monaten vor.
  assertEquals(p.positionen.filter((x) => x.art === "kontogebuehr").map((x) => x.am),
    ["2026-09-16", "2026-10-16"]);
});

Deno.test("Kalender: ein Termin am 31. rutscht nicht in den Folgemonat", () => {
  // Der Februar hat keinen 31. Ohne Sonderbehandlung landete die Buchung am
  // 3. März — ein Termin, den es nie gab.
  const p = zahlungsplan({
    ...EINGABE,
    rhythmus: { ...EINGABE.rhythmus, naechste: [] },
    werbung: { ...EINGABE.werbung, art: "zu_wenig_daten", je_tag: null },
    umsatzsteuer: { faellig_am: null, betrag: null },
    termine: [{
      art: "FBA Inventory Storage Fee", tag_im_monat: 31, belege: 3, treffer: 3,
      letzte_buchung: "2027-01-31", letzter_betrag: -100, schnitt_betrag: -100,
    }],
    tage: 60,
  }, new Date("2027-02-01T00:00:00Z"));

  const tage = p.positionen.filter((x) => x.art === "lagergebuehr").map((x) => x.am);
  assertEquals(tage, ["2027-02-28", "2027-03-31"]);
});

Deno.test("Kalender: Werbung erscheint wochenweise, nicht als Scheingenauigkeit", () => {
  const p = zahlungsplan(EINGABE, HEUTE);
  const w = p.positionen.filter((x) => x.art === "werbung");
  // Die erste Woche ist angebrochen (Do 10.09. bis So 13.09. = 4 Tage).
  assertEquals(w[0].am, "2026-09-10");
  assertEquals(w[0].betrag, -1547.4);
  assertEquals(w[0].bezeichnung, "Werbekosten (4 Tage)");
  // Eine volle Woche danach.
  assertEquals(w[1].betrag, -2707.95);
});

Deno.test("Kalender: Umsatzsteuer als Abfluss, mit dem Vorbehalt in der Grundlage", () => {
  const p = zahlungsplan(EINGABE, HEUTE);
  const ust = p.positionen.find((x) => x.art === "umsatzsteuer")!;
  assertEquals(ust.am, "2026-10-10");
  // Vorzeichen: Abfluss, auch wenn der Betrag positiv hereinkommt.
  assertEquals(ust.betrag, -5450.5);
  assertEquals(ust.grundlage.includes("Vorsteuer aus"), true);
});

Deno.test("Kalender: fehlende Grundlagen werden benannt, nicht gefüllt", () => {
  const p = zahlungsplan({
    ...EINGABE,
    rhythmus: { ...EINGABE.rhythmus, naechste: [] },
    umsatzsteuer: { faellig_am: null, betrag: null },
    werbung: { ...EINGABE.werbung, art: "zu_wenig_daten", je_tag: null },
    termine: [{
      art: "FBA Inventory Storage Fee", tag_im_monat: null, belege: 4, treffer: 2,
      letzte_buchung: "2026-09-07", letzter_betrag: -10, schnitt_betrag: -10,
    }],
  }, HEUTE);

  assertEquals(p.positionen.length, 0);
  // Vier Lücken, vier Sätze — statt eines leeren Kalenders ohne Erklärung.
  assertEquals(p.hinweise.length, 4);
  assertEquals(p.hinweise.some((h) => h.includes("größte Einzelabfluss")), true);
  assertEquals(p.hinweise.some((h) => h.includes("zu günstig dargestellt")), true);
});

Deno.test("Kalender: Wochensummen fassen zusammen, ohne Kontostand zu erfinden", () => {
  const p = zahlungsplan(EINGABE, HEUTE);
  const erste = p.wochen[0];
  // Woche ab Mo 07.09.: Auszahlung 7.934,59 minus Werbung 1.547,40.
  assertEquals(erste.ab, "2026-09-07");
  assertEquals(erste.zufluss, 7934.59);
  assertEquals(erste.abfluss, -1547.4);
  assertEquals(erste.saldo, 6387.19);
  // Alles hier ist fortgeschrieben — das muss die Woche mittragen.
  assertEquals(erste.unsicher, true);
});

// Tests für cashflow_ust.ts.
//
// Die Zahlen sind die gemessenen Vaneja-Werte für August 2026: 9.082,54 €
// vereinnahmte Steuer auf Amazon.de, 254,86 € auf Amazon.fr, 21.107,59 €
// Bestellgebühren brutto, 257,69 € separat ausgewiesene Vorsteuer.

import { assertEquals } from "jsr:@std/assert@1";
import { marktplatzLand, umsatzsteuerZahllast, type UstZeile } from "./cashflow_ust.ts";

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
  assertEquals(m.ausland, [{ marktplatz: "Amazon.fr", vereinnahmt: 254.86 }]);
  assertEquals(m.ausland_summe, 254.86);
  assertEquals(u.faellig_am, "2026-09-10");
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

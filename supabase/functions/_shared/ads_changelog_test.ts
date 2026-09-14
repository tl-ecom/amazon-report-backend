// Tests für ads_changelog.ts.
//
// Die Zahlen sind aus Vanejas echtem Lauf: 783 Änderungen in 90 Tagen, davon
// 456 taggenau, 290 mit Traffic, 74 mit genug Klicks für ein Vorher/Nachher.
// Genau diese Aufteilung soll der Code abbilden, statt alles als vergleichbar
// auszugeben.

import { assertEquals } from "jsr:@std/assert@1";
import { baueAenderung, KLICKS_FUER_VERGLEICH, type ChangelogZeile } from "./ads_changelog.ts";

function zeile(ueber: Partial<ChangelogZeile> = {}): ChangelogZeile {
  return {
    am: "2026-08-20", luecke_tage: 0, art: "gebot",
    ad_product: "SP", campaign_id: "C1", campaign_name: "SP kw exact Etagere",
    ad_group_name: "AG1", ziel_id: "Z1", ziel_text: "obst etagere", match_type: "EXACT",
    vorher: "0.50", nachher: "0.80", richtung: "hoch",
    vorher_impressions: 4000, vorher_clicks: 40, vorher_spend_cents: 2000,
    vorher_sales_cents: 10000, vorher_orders: 4,
    nachher_impressions: 6000, nachher_clicks: 50, nachher_spend_cents: 4000,
    nachher_sales_cents: 12000, nachher_orders: 5,
    nachlauf_vollstaendig: true,
    ...ueber,
  };
}

Deno.test("Änderung: ACoS und CPC aus beiden Fenstern", () => {
  const a = baueAenderung(zeile());
  // 20 € auf 100 € Umsatz = 20 % ACoS, danach 40 € auf 120 € = 33,33 %.
  assertEquals(a.davor.acos, 0.2);
  assertEquals(a.danach.acos, 0.3333);
  assertEquals(a.acos_differenz, 0.1333);
  // CPC 0,50 → 0,80: plus 60 %. Das ist die Erhöhung, die auch im Gebot steht.
  assertEquals(a.davor.cpc, 0.5);
  assertEquals(a.danach.cpc, 0.8);
  assertEquals(a.cpc_veraenderung_prozent, 60);
  assertEquals(a.vergleichbar, true);
  assertEquals(a.grund, null);
});

Deno.test("Änderung: ohne Umsatz ist ACoS nicht definiert, nicht unendlich", () => {
  // Eine erfundene Zahl fuer "kein Umsatz" wuerde jede Rangliste verfaelschen.
  const a = baueAenderung(zeile({ nachher_sales_cents: 0, nachher_orders: 0 }));
  assertEquals(a.danach.acos, null);
  assertEquals(a.acos_differenz, null);
  // Die Klicks bleiben trotzdem gemessen — der Fall ist auswertbar, nur der
  // ACoS nicht.
  assertEquals(a.danach.klicks, 50);
  assertEquals(a.vergleichbar, true);
});

Deno.test("Änderung: zu wenig Traffic wird benannt, nicht bewertet", () => {
  const a = baueAenderung(zeile({
    vorher_clicks: 2, nachher_clicks: 1,
    vorher_spend_cents: 100, nachher_spend_cents: 90,
    vorher_sales_cents: 0, nachher_sales_cents: 4000, nachher_orders: 1,
  }));
  assertEquals(a.vergleichbar, false);
  // Ohne diesen Satz sähe "ACoS von — auf 2 %" nach einem Erfolg aus.
  assertEquals(a.grund?.includes("Zufall, kein Messwert"), true);
  assertEquals(a.grund?.includes("2 Klicks davor"), true);
  assertEquals(a.acos_differenz, null);
  assertEquals(a.cpc_veraenderung_prozent, null);
});

Deno.test("Änderung: angeschnittener Nachlauf zählt nicht als Ergebnis", () => {
  const a = baueAenderung(zeile({ nachlauf_vollstaendig: false }));
  assertEquals(a.vergleichbar, false);
  assertEquals(a.grund?.includes("noch nicht vollständig"), true);
  // Die Zahlen stehen trotzdem da — sie sind nur nicht vergleichbar.
  assertEquals(a.danach.klicks, 50);
});

Deno.test("Änderung: Datierung nennt das Fenster, wenn Tage fehlen", () => {
  const genau = baueAenderung(zeile({ luecke_tage: 0 }));
  assertEquals(genau.datierung, "Tag steht fest");

  // Bei Vaneja haben nur 499 von 1.727 Zielen eine lueckenlose Reihe. Eine
  // Aenderung nach 25 stillen Tagen auf den 11.09. zu datieren waere geraten.
  const ungenau = baueAenderung(zeile({ luecke_tage: 25 }));
  assertEquals(ungenau.datierung.includes("25 Tagen davor"), true);
});

Deno.test("Änderung: Statuswechsel wird als eigene Art geführt", () => {
  const a = baueAenderung(zeile({
    art: "status", vorher: "ENABLED", nachher: "PAUSED", richtung: "runter",
  }));
  assertEquals(a.art, "status");
  assertEquals(a.vorher, "ENABLED");
  assertEquals(a.nachher, "PAUSED");
  // Gebot und Status in eine Zeile zu mischen waere bequem und falsch: das
  // sind zwei Entscheidungen.
  assertEquals(a.richtung, "runter");
});

Deno.test("Schwelle ist eine Konstante, keine verstreute Zahl", () => {
  assertEquals(KLICKS_FUER_VERGLEICH, 5);
  const knapp = baueAenderung(zeile({ vorher_clicks: 5, nachher_clicks: 5 }));
  assertEquals(knapp.vergleichbar, true);
  const drunter = baueAenderung(zeile({ vorher_clicks: 4, nachher_clicks: 9 }));
  assertEquals(drunter.vergleichbar, false);
});

// Tests für produkte.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Geprüft wird die Kette, die den Break-even ACOS herleitet. Sie ist deshalb
// heikel, weil zwei verschiedene Steuerbeträge herausgerechnet werden müssen
// (Umsatzsteuer auf den Umsatz, Vorsteuer in den Gebühren) und weil an mehreren
// Stellen „unbekannt" von „null" zu unterscheiden ist.
//
// Die Zahlen der Fixtures sind bewusst rund gewählt: 119,00 brutto sind bei
// 19 % genau 100,00 netto. So lässt sich jede Erwartung im Kopf nachrechnen,
// statt sie aus dem Code abzuschreiben.

import { assertEquals } from "jsr:@std/assert@1";
import { produktUebersicht } from "./produkte.ts";

const STEUERPROFIL = {
  firmensitz_land: "DE",
  vorsteuerabzug: true,
  umsatzsteuer_prozent: 19,
  gebuehren_ust_faktor: null,
};

/**
 * Doppelgänger des Supabase-Clients. Muster wie in einstellungen_test.ts, nur
 * mit mehreren Tabellen und zwei RPCs.
 *
 * tenant_einstellungen wird von ZWEI Stellen gelesen (ladeUstFaktor und der
 * Umsatzsteuersatz) — beide bekommen dieselbe Zeile, die deshalb alle Felder
 * tragen muss.
 */
function client(opts: {
  produkte?: unknown[];
  ads?: unknown[];
  einstellungen?: unknown;
  jeAsin?: unknown[];
}) {
  const tabelle = (daten: unknown) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => b,
      then: (res: any) => Promise.resolve({ data: daten, error: null }).then(res),
    };
    return b;
  };
  return {
    from: (name: string) =>
      name === "asin_einstellungen"
        ? tabelle(opts.jeAsin ?? [])
        : tabelle(opts.einstellungen === undefined ? STEUERPROFIL : opts.einstellungen),
    rpc: (name: string) =>
      Promise.resolve({
        data: name === "ads_summen" ? (opts.ads ?? []) : (opts.produkte ?? []),
        error: null,
      }),
  } as any;
}

/** Eine Zeile, wie sie die RPC produkt_uebersicht liefert. */
function zeile(o: Record<string, unknown> = {}) {
  return {
    asin: "B001", produktname: "Testartikel",
    umsatz_cents: 11900, einheiten: 10,
    wareneinsatz_cents: 3000, einheiten_mit_ek: 10,
    retouren: 0,
    // signiert: negativ = Kosten, und brutto — die Vorsteuer steckt drin.
    gebuehren_cents: -2380, gebuehren_bekannt: true, gebuehren_anteilig: false,
    fba_cents: -1190, verkaufsgebuehr_cents: -1190, sonstige_gebuehren_cents: 0,
    ...o,
  };
}

/** Eine ASIN-Zeile, wie sie ads_summen liefert. */
function adsZeile(asin: string, spend_cents: number) {
  return {
    ebene: "asin", schluessel: asin, bezeichnung: null,
    impressions: 0, clicks: 0, spend_cents, sales_cents: 0, orders: 0, einheiten: 0,
  };
}

const ZEITRAUM = { von: "2026-07-01", bis: "2026-07-31" };

async function ersterArtikel(opts: Parameters<typeof client>[0]) {
  const r = await produktUebersicht(client(opts), "t", ZEITRAUM) as any;
  return r.produkte[0];
}

Deno.test("Kette je Stueck: 119 brutto -> 10 Euro Deckungsbeitrag", async () => {
  // 119,00 brutto / 10 Stk = 11,90; bei 19 % sind das 10,00 netto je Stueck.
  // Gebuehren 23,80 brutto = 20,00 netto = 2,00 je Stueck. EK 3,00 je Stueck.
  // Bleibt 5,00 Deckungsbeitrag vor Werbung.
  const p = await ersterArtikel({ produkte: [zeile()], ads: [adsZeile("B001", 1000)] });

  assertEquals(p.vk_brutto, 11.9);
  assertEquals(p.ust_je_stueck, 1.9);
  assertEquals(p.vk_netto, 10);
  assertEquals(p.gebuehren_je_stueck, 2);
  assertEquals(p.ek_je_stueck, 3);
  assertEquals(p.db_vor_werbung_je_stueck, 5);
});

Deno.test("Gebuehren-Aufschluesselung summiert sich zur Gesamtgebuehr", async () => {
  // Fixture: 11,90 FBA + 11,90 Provision = 23,80 brutto = 20,00 netto,
  // also 1,00 + 1,00 = 2,00 je Stueck. Wer die Summe nicht nachrechnen kann,
  // muss der Aufschluesselung glauben — deshalb dieser Test.
  const p = await ersterArtikel({ produkte: [zeile()] });
  assertEquals(p.fba_je_stueck, 1);
  assertEquals(p.verkaufsgebuehr_je_stueck, 1);
  assertEquals(p.sonstige_je_stueck, 0);
  assertEquals(
    p.fba_je_stueck + p.verkaufsgebuehr_je_stueck + p.sonstige_je_stueck,
    p.gebuehren_je_stueck,
  );
});

Deno.test("Break-even ACOS ist der Deckungsbeitrag vor Werbung in Prozent", async () => {
  // 50,00 von 100,00 Nettoumsatz -> 50 %. Genau das ist die Aussage der Zahl:
  // so viel Werbung vertraegt das Produkt, bevor es sich nicht mehr traegt.
  const p = await ersterArtikel({ produkte: [zeile()], ads: [adsZeile("B001", 1000)] });
  assertEquals(p.break_even_acos, 50);
});

Deno.test("Werbung wird abgezogen, TACOS misst sie am Nettoumsatz", async () => {
  // 10,00 Werbung auf 100,00 Nettoumsatz -> TACOS 10 %, und je Stueck 1,00.
  const p = await ersterArtikel({ produkte: [zeile()], ads: [adsZeile("B001", 1000)] });
  assertEquals(p.werbung_je_stueck, 1);
  assertEquals(p.db_nach_werbung_je_stueck, 4);
  assertEquals(p.tacos, 10);
});

Deno.test("Gebuehren werden NETTO gerechnet, nicht wie gebucht", async () => {
  // Amazon bucht 23,80 brutto. Bei Vorsteuerabzug sind davon 20,00 echte Kosten.
  // Wer die 23,80 stehen laesst, macht die Marge systematisch zu schlecht —
  // und wer die Umsatzsteuer im Umsatz laesst, zu gut.
  const p = await ersterArtikel({ produkte: [zeile()] });
  assertEquals(p.gebuehren, -20);
  assertEquals(p.gebuehrenquote, 20);
});

Deno.test("Ohne Einkaufspreis bleibt die Kette leer, nicht 0", async () => {
  // Ein erfundener Break-even ist schlimmer als keiner.
  const p = await ersterArtikel({
    produkte: [zeile({ wareneinsatz_cents: 0, einheiten_mit_ek: 0 })],
  });
  assertEquals(p.ek_je_stueck, null);
  assertEquals(p.db_vor_werbung_je_stueck, null);
  assertEquals(p.break_even_acos, null);
  assertEquals(p.rohmarge, null);
  // Was ohne EK trotzdem bekannt ist, wird auch gezeigt.
  assertEquals(p.vk_netto, 10);
  assertEquals(p.gebuehren_je_stueck, 2);
});

Deno.test("Ohne Gebuehrenbuchung bleibt die Kette leer, nicht 0", async () => {
  const p = await ersterArtikel({
    produkte: [zeile({ gebuehren_bekannt: false, gebuehren_cents: 0 })],
  });
  assertEquals(p.gebuehren_je_stueck, null);
  assertEquals(p.db_vor_werbung_je_stueck, null);
  assertEquals(p.break_even_acos, null);
});

Deno.test("Ohne Ads-Verbindung ist Werbung UNBEKANNT, nicht 0", async () => {
  // Sonst stuende dort ein Deckungsbeitrag, den es so nicht gibt.
  const p = await ersterArtikel({ produkte: [zeile()], ads: [] });
  assertEquals(p.werbekosten, null);
  assertEquals(p.werbung_je_stueck, null);
  assertEquals(p.tacos, null);
  assertEquals(p.db_nach_werbung_je_stueck, null);
  // Die Stufe davor bleibt berechenbar.
  assertEquals(p.db_vor_werbung_je_stueck, 5);
});

Deno.test("Mit Ads-Verbindung, aber ohne Ausgaben fuer DIESE ASIN, ist Werbung 0", async () => {
  // Feiner, aber wichtiger Unterschied zum Test davor: hier ist bekannt, dass
  // nicht geworben wurde. Das ist eine Aussage, kein fehlender Wert.
  const p = await ersterArtikel({ produkte: [zeile()], ads: [adsZeile("B999", 5000)] });
  assertEquals(p.werbung_je_stueck, 0);
  assertEquals(p.tacos, 0);
  assertEquals(p.db_nach_werbung_je_stueck, 5);
});

Deno.test("Steuersatz je Produkt schlaegt den Mandanten-Wert", async () => {
  // 107,00 brutto sind bei 7 % genau 100,00 netto. Mit dem Mandanten-Wert von
  // 19 % kaeme 89,92 heraus — fuer ein gemischtes Sortiment waere das falsch.
  const p = await ersterArtikel({
    produkte: [zeile({ umsatz_cents: 10700 })],
    jeAsin: [{ asin: "B001", ziel_acos_prozent: null, ust_prozent: 7 }],
  });
  assertEquals(p.ust_prozent, 7);
  assertEquals(p.vk_netto, 10);
  assertEquals(p.ust_je_stueck, 0.7);
});

Deno.test("Ziel-ACOS kommt je Produkt durch", async () => {
  const p = await ersterArtikel({
    produkte: [zeile()],
    jeAsin: [{ asin: "B001", ziel_acos_prozent: 25, ust_prozent: null }],
  });
  assertEquals(p.ziel_acos_prozent, 25);
});

Deno.test("Ohne Eintrag in asin_einstellungen gilt der Mandanten-Steuersatz", async () => {
  const p = await ersterArtikel({ produkte: [zeile()], jeAsin: [] });
  assertEquals(p.ust_prozent, 19);
  assertEquals(p.ziel_acos_prozent, null);
  assertEquals(p.vk_netto, 10);
});

Deno.test("hat_werbekosten sagt, ob das Endergebnis vollstaendig ist", async () => {
  const mit = await produktUebersicht(
    client({ produkte: [zeile()], ads: [adsZeile("B001", 1000)] }), "t", ZEITRAUM) as any;
  assertEquals(mit.hat_werbekosten, true);
  assertEquals(mit.fehlt, []);

  const ohne = await produktUebersicht(
    client({ produkte: [zeile()], ads: [] }), "t", ZEITRAUM) as any;
  assertEquals(ohne.hat_werbekosten, false);
  assertEquals(ohne.fehlt.length, 1);
});

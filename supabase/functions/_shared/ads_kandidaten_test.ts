// Tests für ads_kandidaten.ts. Die Fälle stammen aus Vanejas Lauf vom
// 04.10.2026 (60 Tage): "koch chemie" über das eigene Exact-Keyword ohne
// Bestellung, eine ASIN mit 90 Klicks ohne Bestellung, und ein Begriff, der
// in der einen Gruppe nichts bringt und in der anderen verkauft.

import { assertEquals } from "jsr:@std/assert@1";
import {
  anlageFuer, baueErnteKandidaten, baueNegativKandidaten, begriffeFuerAsin, istAsin,
  type KandidatZeile, margenAus, schaerfeErnte, zufallProzent,
} from "./ads_kandidaten.ts";

function zeile(ueber: Partial<KandidatZeile> = {}): KandidatZeile {
  return {
    campaign_id: "C1", campaign_name: "SP Auto", ad_group_id: "G1", ad_group_name: "Auto",
    suchbegriff: "obst etagere holz", match_types: ["BROAD"],
    impressions: 2000, clicks: 20, spend_cents: 1500, sales_cents: 0, orders: 0,
    asins: ["B0AAAAAAAA"], negativ_vorhanden: false, ist_ziel_der_gruppe: false, exact_im_konto: null,
    ...ueber,
  };
}

Deno.test("Zufall: zehn Klicks ohne Bestellung sind bei 11 % CVR oft Pech", () => {
  assertEquals(zufallProzent(10, 0.11), 31.2);
  assertEquals(zufallProzent(30, 0.11), 3);
  assertEquals(zufallProzent(10, null), null);
  assertEquals(zufallProzent(10, 0), null);
});

Deno.test("Negativ: schon Ausgeschlossenes und zu wenig Klicks bleiben draußen", () => {
  const n = baueNegativKandidaten([
    zeile(),
    zeile({ suchbegriff: "schon weg", negativ_vorhanden: true }),
    zeile({ suchbegriff: "zu wenig", clicks: 4 }),
    zeile({ suchbegriff: "verkauft", orders: 2, sales_cents: 5000 }),
  ], 0.11);
  assertEquals(n.map((x) => x.suchbegriff), ["obst etagere holz"]);
  assertEquals(n[0].aktion, "negativ_anlegen");
  assertEquals(n[0].kosten, 15);
  assertEquals(n[0].zufall_prozent, 9.7);
});

Deno.test("Negativ: läuft der Begriff über sein eigenes Exact-Keyword, wird das Ziel geprüft", () => {
  const n = baueNegativKandidaten([zeile({ suchbegriff: "koch chemie", match_types: ["EXACT"], ist_ziel_der_gruppe: true, exact_im_konto: "aktiv" })], 0.11);
  assertEquals(n[0].aktion, "ziel_pruefen");
});

Deno.test("Negativ: ASIN wird als ASIN erkannt, und Bestellungen anderswo stehen dabei", () => {
  const n = baueNegativKandidaten([
    zeile({ suchbegriff: "b0gpxhxzm7", clicks: 90, spend_cents: 3763, match_types: ["TARGETING_EXPRESSION"] }),
    zeile({ suchbegriff: "bananenhalter", ad_group_id: "G1" }),
    zeile({ suchbegriff: "bananenhalter", ad_group_id: "G2", orders: 3, sales_cents: 6000 }),
  ], 0.11);
  assertEquals(n.map((x) => [x.suchbegriff, x.typ, x.bestellungen_anderswo]), [
    ["b0gpxhxzm7", "asin", 0],
    ["bananenhalter", "suchbegriff", 3],
  ]);
  assertEquals(istAsin("B0GPXHXZM7"), true);
  assertEquals(istAsin("b0 gpxhxzm7"), false);
});

Deno.test("Ernte: je Begriff summiert, ohne aktives Exact und ohne ASINs", () => {
  const e = baueErnteKandidaten([
    zeile({ suchbegriff: "etagere 3 stöckig", clicks: 10, spend_cents: 600, sales_cents: 4000, orders: 1 }),
    zeile({ suchbegriff: "etagere 3 stöckig", ad_group_id: "G2", ad_group_name: "Phrase", match_types: ["PHRASE"], clicks: 30, spend_cents: 1400, sales_cents: 8000, orders: 2 }),
    zeile({ suchbegriff: "hat exact", orders: 5, sales_cents: 9000, exact_im_konto: "aktiv" }),
    zeile({ suchbegriff: "b0745lsrnf", orders: 4, sales_cents: 9000 }),
    zeile({ suchbegriff: "nur einmal", orders: 1, sales_cents: 2000 }),
    zeile({ suchbegriff: "pausiert", orders: 2, sales_cents: 4000, exact_im_konto: "pausiert" }),
  ]);
  assertEquals(e.map((x) => x.suchbegriff), ["etagere 3 stöckig", "pausiert"]);
  const a = e[0];
  assertEquals([a.bestellungen, a.klicks, a.kosten, a.umsatz], [3, 40, 20, 120]);
  assertEquals([a.acos, a.cvr, a.cpc], [0.1667, 0.075, 0.5]);
  // Die stärkste Quelle zuerst.
  assertEquals(a.quellen[0].adGroupName, "Phrase");
  assertEquals(e[1].exact_pausiert, true);
});

Deno.test("Je ASIN: mehrere ASINs in der Gruppe heißt nicht eindeutig", () => {
  const b = begriffeFuerAsin([
    zeile({ suchbegriff: "allein", asins: ["B0AAAAAAAA"], orders: 1, sales_cents: 3000 }),
    zeile({ suchbegriff: "geteilt", asins: ["B0AAAAAAAA", "B0BBBBBBBB"], spend_cents: 9000 }),
    zeile({ suchbegriff: "fremd", asins: ["B0CCCCCCCC"] }),
  ], "b0aaaaaaaa");
  assertEquals(b.map((x) => [x.suchbegriff, x.eindeutig, x.weitere_asins]), [
    ["geteilt", false, ["B0BBBBBBBB"]],
    ["allein", true, []],
  ]);
});

Deno.test("Margen: Break-even auf Bruttoumsatz, nicht auf Netto", () => {
  // 30 € Deckungsbeitrag vor Werbung auf 100 € netto / 119 € brutto:
  // 30 % auf Netto, aber 25,2 % gemessen an dem, was Amazons ACoS als Umsatz zählt.
  const m = margenAus([{ asin: "b0aaaaaaaa", produktname: "Etagere", umsatz: 100, umsatz_brutto: 119, nettogewinn_vor_werbung: 30, ziel_acos_prozent: 20 }]);
  const p = m.get("B0AAAAAAAA")!;
  assertEquals(Math.round(p.break_even! * 1000) / 1000, 0.252);
  assertEquals(p.ziel_acos, 0.2);
  // Ohne Einkaufspreis gibt es keinen Deckungsbeitrag — dann auch keinen Break-even.
  assertEquals(margenAus([{ asin: "X", umsatz_brutto: 119, nettogewinn_vor_werbung: null }]).get("X")!.break_even, null);
});

Deno.test("Ernte geschärft: Rangfolge nach Deckungsbeitrag, nicht nach Bestellungen", () => {
  const ernte = baueErnteKandidaten([
    // Viele Bestellungen, aber 76 % ACoS (Vanejas "warnweste kinder 6-12 jahre").
    zeile({ suchbegriff: "warnweste kinder", clicks: 47, spend_cents: 7600, sales_cents: 10000, orders: 10, asins: ["B0WESTE0000"] }),
    // Wenige Bestellungen, 5 % ACoS ("kühlmanschette flasche").
    zeile({ suchbegriff: "kühlmanschette flasche", clicks: 23, spend_cents: 700, sales_cents: 14000, orders: 7, asins: ["B0KUEHLER00"] }),
    zeile({ suchbegriff: "ohne ek", clicks: 20, spend_cents: 500, sales_cents: 5000, orders: 3, asins: ["B0OHNEEK000"] }),
  ]);
  const margen = new Map([
    ["B0WESTE0000", { produktname: "Warnweste", break_even: 0.25, ziel_acos: null }],
    ["B0KUEHLER00", { produktname: "Kühlmanschette", break_even: 0.30, ziel_acos: 0.15 }],
    ["B0OHNEEK000", { produktname: "Ohne EK", break_even: null, ziel_acos: null }],
  ]);
  const g = schaerfeErnte(ernte, margen, { klicks: 22337, bestellungen: 2472 });
  assertEquals(g.map((x) => [x.suchbegriff, x.einordnung, x.gewinn_nach_werbung]), [
    ["kühlmanschette flasche", "traegt_sich", 35],        // 140 x 0,30 - 7
    ["warnweste kinder", "ueber_break_even", -51],        // 100 x 0,25 - 76
    ["ohne ek", "marge_unbekannt", null],
  ]);
  // Zielgebot zielt auf das gesetzte Ziel, sonst auf den Break-even (= Obergrenze).
  assertEquals([g[0].zielgebot_basis, g[1].zielgebot_basis, g[2].zielgebot], ["ziel_acos", "break_even", null]);
  // 20 € je Bestellung x 15 % x CVR. CVR zur Konto-CVR gezogen: (7 + 15 x 0,1107) / (23 + 15) = 0,2279.
  assertEquals(g[0].cvr_geschaetzt, 0.2279);
  assertEquals(g[0].zielgebot, 0.68);
  assertEquals(g[0].produkt, "Kühlmanschette");
});

Deno.test("Ernte geschärft: mehrere ASINs heißt schwächste Marge und kein Produktname", () => {
  const ernte = baueErnteKandidaten([
    zeile({ suchbegriff: "etagere", clicks: 30, spend_cents: 2000, sales_cents: 10000, orders: 4, asins: ["B0AAAAAAAA", "B0BBBBBBBB"] }),
  ]);
  const g = schaerfeErnte(ernte, new Map([
    ["B0AAAAAAAA", { produktname: "A", break_even: 0.35, ziel_acos: null }],
    ["B0BBBBBBBB", { produktname: "B", break_even: 0.18, ziel_acos: null }],
  ]), { klicks: 1000, bestellungen: 100 })[0];
  assertEquals([g.asin_eindeutig, g.produkt, g.break_even_acos], [false, null, 0.18]);
  // 20 % ACoS gegen die schwächere Marge von 18 %: trägt sich nicht.
  assertEquals([g.einordnung, g.gewinn_nach_werbung], ["ueber_break_even", -2]);
});

// Vanejas Biomülleimer am 05.10.2026: zwei Sammel-Kampagnen und zwei Single-Keyword-Kampagnen.
const BIO = [
  { campaign_id: "122131778974893", campaign_name: "SPM Biomülleimer MK Profit", ad_group_id: "298495228157363", exact_keywords: 15, asins: ["B0D7D2NMT4"] },
  { campaign_id: "102049191376153", campaign_name: "SPM Biomüllereimer MK Exact LOW", ad_group_id: "407813841660253", exact_keywords: 12, asins: ["B0D7D2NMT4"] },
  { campaign_id: "95723114588600", campaign_name: "SP KW Phrase Papiertüten", ad_group_id: "1", exact_keywords: 40, asins: ["B0D7D2NMT4"] },
];
const modus = (id: string) => id === "95723114588600" ? "nur_analyse" as const : "pulse" as const;

Deno.test("Anlage: größte Exact-Gruppe des Produkts, nie eine nur ausgewertete Kampagne", () => {
  const a = anlageFuer({ asins: ["b0d7d2nmt4"], cpc: 0.62, zielgebot: 8.45, zielgebot_basis: "break_even" }, BIO, modus)!;
  assertEquals(a.campaignName, "SPM Biomülleimer MK Profit");
  assertEquals(a.alternativen, 1);
  // Ohne Ziel-ACoS der bisherige Klickpreis, nicht die Break-even-Obergrenze.
  assertEquals(a.startgebot, 0.62);
  assertEquals(a.unter_klickpreis, false);
});

Deno.test("Anlage: Zielgebot unter dem Klickpreis wird gekennzeichnet; ohne passende Gruppe null", () => {
  const a = anlageFuer({ asins: ["B0D7D2NMT4"], cpc: 1.21, zielgebot: 0.71, zielgebot_basis: "ziel_acos" }, BIO, modus)!;
  assertEquals(a.startgebot, 0.71);
  assertEquals(a.unter_klickpreis, true);
  assertEquals(anlageFuer({ asins: ["B0XXXXXXXX"], cpc: 1, zielgebot: null, zielgebot_basis: null }, BIO, modus), null);
});

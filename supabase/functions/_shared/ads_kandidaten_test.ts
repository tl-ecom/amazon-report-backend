// Tests für ads_kandidaten.ts. Die Fälle stammen aus Vanejas Lauf vom
// 04.10.2026 (60 Tage): "koch chemie" über das eigene Exact-Keyword ohne
// Bestellung, eine ASIN mit 90 Klicks ohne Bestellung, und ein Begriff, der
// in der einen Gruppe nichts bringt und in der anderen verkauft.

import { assertEquals } from "jsr:@std/assert@1";
import {
  baueErnteKandidaten, baueNegativKandidaten, begriffeFuerAsin, istAsin,
  type KandidatZeile, zufallProzent,
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

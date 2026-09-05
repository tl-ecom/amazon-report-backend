// Tests für ads_struktur.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Die Zeilenbauer sind das Nadelöhr: was hier falsch abgebildet wird, steht
// morgen als „aktueller Stand" in der Datenbank. Besonders die Unterscheidung
// eigenes Gebot / geerbtes Gebot darf nicht verloren gehen.

import { assertEquals } from "jsr:@std/assert@1";
import {
  baueAnzeigengruppenRows,
  baueKampagnenRows,
  baueZieleRows,
  effektivesGebot,
  type StrukturRohdaten,
} from "./ads_struktur.ts";

const T = "11111111-1111-1111-1111-111111111111";
const STEMPEL = "2026-09-05T04:05:00.000Z";

function leer(): StrukturRohdaten {
  return {
    kampagnen: [], anzeigengruppen: [], keywords: [], targets: [],
    negativeKeywords: [], negativeTargets: [], kampagnenNegativeKeywords: [], kampagnenNegativeTargets: [],
  };
}

Deno.test("Kampagne: Budget in Cent, Modifier je Platzierung, Stempel", () => {
  const rows = baueKampagnenRows(T, [{
    campaignId: 123, name: "SP Auto", state: "ENABLED", targetingType: "AUTO",
    budget: { budget: 25.5, budgetType: "DAILY" },
    dynamicBidding: {
      strategy: "LEGACY_FOR_SALES",
      placementBidding: [
        { placement: "PLACEMENT_TOP", percentage: 40 },
        { placement: "PLACEMENT_PRODUCT_PAGE", percentage: 0 },
      ],
    },
    startDate: "2026-01-15",
  }], STEMPEL);
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.campaign_id, "123");
  assertEquals(r.budget_cents, 2550);
  assertEquals(r.budget_typ, "DAILY");
  assertEquals(r.mod_top_prozent, 40);
  assertEquals(r.mod_produktseite_prozent, 0);
  // Nicht gesetzt ist nicht 0 — Amazon hat dafür keinen Eintrag geliefert.
  assertEquals(r.mod_rest_prozent, null);
  assertEquals(r.start_datum, "2026-01-15");
  assertEquals(r.gesehen_am, STEMPEL);
});

Deno.test("Kampagne: altes Datumsformat YYYYMMDD wird normalisiert", () => {
  const rows = baueKampagnenRows(T, [{ campaignId: "1", startDate: "20260115" }], STEMPEL);
  assertEquals(rows[0].start_datum, "2026-01-15");
});

Deno.test("Kampagne ohne ID wird verworfen, ohne Budget bleibt null", () => {
  const rows = baueKampagnenRows(T, [{ name: "ohne id" }, { campaignId: "9" }], STEMPEL);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].budget_cents, null);
});

Deno.test("Anzeigengruppe: Standardgebot in Cent", () => {
  const rows = baueAnzeigengruppenRows(T, [{ adGroupId: 7, campaignId: 1, name: "G", state: "ENABLED", defaultBid: 0.75 }], STEMPEL);
  assertEquals(rows[0].ad_group_id, "7");
  assertEquals(rows[0].campaign_id, "1");
  assertEquals(rows[0].standard_gebot_cents, 75);
});

Deno.test("Ziele: Keyword mit eigenem Gebot, Keyword ohne Gebot bleibt null", () => {
  const roh = leer();
  roh.keywords = [
    { keywordId: 1, campaignId: 10, adGroupId: 20, keywordText: "staubsauger beutel", matchType: "EXACT", state: "ENABLED", bid: 0.42 },
    { keywordId: 2, campaignId: 10, adGroupId: 20, keywordText: "beutel", matchType: "BROAD", state: "PAUSED" },
  ];
  const rows = baueZieleRows(T, roh, STEMPEL);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    tenant_id: T, art: "keyword", ziel_id: "1", campaign_id: "10", ad_group_id: "20",
    text: "staubsauger beutel", match_type: "EXACT", state: "ENABLED", gebot_cents: 42, gesehen_am: STEMPEL,
  });
  // Das ist die leere Zelle der Bulk-Datei — sie darf nicht zu 0 werden.
  assertEquals(rows[1].gebot_cents, null);
});

Deno.test("Ziele: Product-Target wird als lesbarer Ausdruck gespeichert", () => {
  const roh = leer();
  roh.targets = [{
    targetId: 5, campaignId: 10, adGroupId: 20, state: "ENABLED", bid: 0.3,
    expressionType: "MANUAL", expression: [{ type: "ASIN_SAME_AS", value: "B0TEST" }],
  }];
  const rows = baueZieleRows(T, roh, STEMPEL);
  assertEquals(rows[0].art, "target");
  assertEquals(rows[0].text, "ASIN_SAME_AS=B0TEST");
  assertEquals(rows[0].match_type, "MANUAL");
});

Deno.test("Ziele: Negatives aller vier Ebenen mit eigener Art, ohne Gebot", () => {
  const roh = leer();
  roh.negativeKeywords = [{ keywordId: 1, campaignId: 10, adGroupId: 20, keywordText: "gratis", matchType: "NEGATIVE_EXACT", state: "ENABLED" }];
  roh.negativeTargets = [{ targetId: 2, campaignId: 10, adGroupId: 20, expression: [{ type: "ASIN_SAME_AS", value: "B0X" }], state: "ENABLED" }];
  roh.kampagnenNegativeKeywords = [{ keywordId: 3, campaignId: 10, keywordText: "billig", matchType: "NEGATIVE_PHRASE", state: "ENABLED" }];
  roh.kampagnenNegativeTargets = [{ targetId: 4, campaignId: 10, expression: [{ type: "ASIN_BRAND_SAME_AS", value: "MARKE" }], state: "ENABLED" }];
  const rows = baueZieleRows(T, roh, STEMPEL);
  assertEquals(rows.map((r) => r.art), ["negativ_keyword", "negativ_target", "kampagne_negativ_keyword", "kampagne_negativ_target"]);
  assertEquals(rows.every((r) => r.gebot_cents === null), true);
  // Kampagnen-Negatives haben keine Anzeigengruppe — Leerstring, weil Teil des Schlüssels.
  assertEquals(rows[2].ad_group_id, "");
});

Deno.test("Ziele: dieselbe ID als Keyword und als Negative kollidiert nicht", () => {
  const roh = leer();
  roh.keywords = [{ keywordId: 1, campaignId: 10, adGroupId: 20, keywordText: "a", matchType: "EXACT", bid: 0.1 }];
  roh.negativeKeywords = [{ keywordId: 1, campaignId: 10, adGroupId: 20, keywordText: "b", matchType: "NEGATIVE_EXACT" }];
  const rows = baueZieleRows(T, roh, STEMPEL);
  assertEquals(rows.length, 2);
  assertEquals(new Set(rows.map((r) => `${r.art}:${r.ziel_id}`)).size, 2);
});

Deno.test("effektivesGebot: eigenes vor geerbtem, beides fehlend ergibt null", () => {
  assertEquals(effektivesGebot(42, 75), { gebot: 0.42, geerbt: false });
  assertEquals(effektivesGebot(null, 75), { gebot: 0.75, geerbt: true });
  assertEquals(effektivesGebot("42", "75"), { gebot: 0.42, geerbt: false });
  assertEquals(effektivesGebot(null, null), { gebot: null, geerbt: false });
});

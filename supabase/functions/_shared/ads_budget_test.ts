// Tests für ads_budget.ts.

import { assertEquals } from "jsr:@std/assert@1";
import { baueAuslastungRows, baueBudgetTag, stundenStill, type TagZeile } from "./ads_budget.ts";

Deno.test("Auslastung: nur Messungen ab der Schwelle werden gespeichert", () => {
  const rows = baueAuslastungRows("T", "DE", [
    { campaignId: "1", budgetUsagePercent: 12.5, budget: 10 },
    { campaignId: 2, budgetUsagePercent: "100", budget: "5.5", usageUpdatedTimestamp: "2026-10-05T12:00:00Z" },
    { campaignId: "3", budgetUsagePercent: 80, budget: null },
    { campaignId: "4", budgetUsagePercent: null },
    { budgetUsagePercent: 100 },
  ], "2026-10-05T12:20:00Z");
  assertEquals(rows.map((r) => [r.campaign_id, r.auslastung_prozent, r.budget_cents]), [
    ["2", 100, 550],
    ["3", 80, null],
  ]);
  assertEquals(rows[0].amazon_stand, "2026-10-05T12:00:00Z");
});

Deno.test("Auslastung: leere oder fehlende Antwort gibt keine Zeilen, keinen Absturz", () => {
  assertEquals(baueAuslastungRows("T", "DE", [], "x"), []);
  assertEquals(baueAuslastungRows("T", "DE", undefined as any, "x"), []);
});

// Vaneja, 04.10.2026: "CP-sp_kw_exact_manual_etagere_vaneja_de", 30 € Budget,
// Amazons Stempel 20:53 deutscher Zeit (18:53 UTC), gemessen um 23:53.
const ETAGERE: TagZeile = {
  tag: "2026-10-04", campaign_id: "C1", campaign_name: "CP-sp_kw_exact_manual_etagere_vaneja_de",
  hoechste: "102.88", n_voll: 1, n_ab_schwelle: 1,
  voll_seit: "2026-10-04T18:53:00+00:00", letzte_bewegung: "2026-10-04T18:53:00+00:00",
  zuletzt_gemessen: "2026-10-04T21:53:27+00:00", budget_cents: 3000,
  tagesende: "2026-10-04T22:00:00+00:00",
};

Deno.test("Budget-Tag: leer seit 20:53, also 3,1 Stunden bis Mitternacht ohne Auslieferung", () => {
  const t = baueBudgetTag(ETAGERE, 1, new Date("2026-10-05T08:00:00Z"));
  assertEquals(
    [t.ausgeschoepft, t.ausgeschoepft_seit, t.stunden_ohne_auslieferung, t.budget],
    [true, "2026-10-04T18:53:00+00:00", 3.1, 30],
  );
  assertEquals([t.messungen_ausgeschoepft, t.messungen_am_tag, t.tag_laeuft_noch], [1, 1, false]);
});

Deno.test("Budget-Tag: läuft der Tag noch, zählt nur die Zeit bis jetzt", () => {
  const t = baueBudgetTag(ETAGERE, 1, new Date("2026-10-04T20:23:00Z"));
  assertEquals([t.stunden_ohne_auslieferung, t.tag_laeuft_noch], [1.5, true]);
});

Deno.test("Budget-Tag: knapp, aber nicht ausgeschöpft — keine Stunden, kein Zeitpunkt", () => {
  const t = baueBudgetTag({ ...ETAGERE, hoechste: 88.2, n_voll: 0, voll_seit: null }, 20, new Date("2026-10-05T08:00:00Z"));
  assertEquals(
    [t.ausgeschoepft, t.ausgeschoepft_seit, t.stunden_ohne_auslieferung, t.hoechste_auslastung],
    [false, null, null, 88.2],
  );
});

Deno.test("stundenStill: ohne Stempel keine Aussage, und nie negativ", () => {
  assertEquals(stundenStill(null, "2026-10-04T22:00:00Z"), null);
  assertEquals(stundenStill("2026-10-04T23:00:00Z", "2026-10-04T22:00:00Z", new Date("2026-10-05T08:00:00Z")), 0);
});

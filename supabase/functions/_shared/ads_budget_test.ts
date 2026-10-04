// Tests für ads_budget.ts.

import { assertEquals } from "jsr:@std/assert@1";
import { baueAuslastungRows, fasseTagZusammen } from "./ads_budget.ts";

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

Deno.test("Tag: erste Messung mit 100 % zählt, und die Zahl der Messungen steht dabei", () => {
  const t = fasseTagZusammen([
    { tag: "2026-10-05", gemessen_am: "2026-10-05T12:20:00Z", auslastung_prozent: 100, budget_cents: 500 },
    { tag: "2026-10-05", gemessen_am: "2026-10-05T10:20:00Z", auslastung_prozent: 85, budget_cents: 500 },
    { tag: "2026-10-05", gemessen_am: "2026-10-05T11:20:00Z", auslastung_prozent: 100, budget_cents: 500 },
  ], 14);
  assertEquals(t, {
    hoechste_auslastung: 100, ausgeschoepft: true, ausgeschoepft_seit: "2026-10-05T11:20:00Z",
    messungen_ausgeschoepft: 2, messungen_am_tag: 14, budget: 5,
  });
});

Deno.test("Tag: knapp, aber nicht ausgeschöpft", () => {
  const t = fasseTagZusammen([
    { tag: "2026-10-05", gemessen_am: "2026-10-05T20:20:00Z", auslastung_prozent: 93.4, budget_cents: null },
  ], 20);
  assertEquals([t.ausgeschoepft, t.ausgeschoepft_seit, t.hoechste_auslastung, t.budget], [false, null, 93.4, null]);
});

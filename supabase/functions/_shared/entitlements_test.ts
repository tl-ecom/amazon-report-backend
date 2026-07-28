import { assertEquals } from "jsr:@std/assert@1";
import { RESOURCE_FEATURE, zugriffErlaubt } from "./entitlements.ts";

Deno.test("Admin darf immer (auch ohne Features)", () => {
  assertEquals(zugriffErlaubt("tasks", null, true), true);
  assertEquals(zugriffErlaubt("fr_experiments", {}, true), true);
});

Deno.test("ungelistete Ressource ist immer erlaubt", () => {
  assertEquals(zugriffErlaubt("pulse_overview", {}, false), true);
  assertEquals(zugriffErlaubt(undefined, {}, false), true);
});

Deno.test("gated: erlaubt nur wenn Feature aktiv", () => {
  assertEquals(zugriffErlaubt("tasks", { tasks: true }, false), true);
  assertEquals(zugriffErlaubt("tasks", { tasks: false }, false), false);
  assertEquals(zugriffErlaubt("tasks", {}, false), false);
  assertEquals(zugriffErlaubt("tasks", null, false), false);
});

Deno.test("Aktion und zugehörige Ressource teilen das Feature", () => {
  const feats = { brief: true };
  assertEquals(zugriffErlaubt("weekly_briefs", feats, false), true);
  assertEquals(zugriffErlaubt("brief_generieren", feats, false), true);
  assertEquals(zugriffErlaubt("brief_notiz", feats, false), true);
});

Deno.test("Verlauf-Reads hängen alle am selben Feature 'verlauf'", () => {
  for (const r of ["get_sales_history", "get_orders_history", "get_returns_history"]) {
    assertEquals(RESOURCE_FEATURE[r], "verlauf");
  }
});

Deno.test("Flight-Recorder-Reads/Write hängen an 'aenderungen'", () => {
  for (const r of ["fr_change_events", "fr_asin_timeline", "fr_set_context"]) {
    assertEquals(RESOURCE_FEATURE[r], "aenderungen");
  }
});

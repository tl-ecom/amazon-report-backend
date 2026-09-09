import { assertEquals } from "jsr:@std/assert@1";
import { coachZugriff, RESOURCE_FEATURE, zugriffErlaubt } from "./entitlements.ts";

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

Deno.test("Cash-Flow haengt an einem eigenen Tarif-Schluessel", () => {
  // Beim Einbauen des Bereichs zuerst vergessen. Der Effekt war heimtueckisch:
  // das Frontend versteckte den Tab (weil das Feature nicht gesetzt war), das
  // Backend liess die Ressource aber durch — ungelistete Schluessel sind
  // absichtlich offen. Ein Kunde ohne das Feature haette die Daten per
  // direktem API-Aufruf bekommen.
  assertEquals(RESOURCE_FEATURE.cashflow, "cashflow");
  assertEquals(RESOURCE_FEATURE.stammdaten, "cashflow");
  assertEquals(RESOURCE_FEATURE.stammdaten_setzen, "cashflow");

  assertEquals(zugriffErlaubt("cashflow", { cashflow: true }, false), true);
  assertEquals(zugriffErlaubt("cashflow", { cashflow: false }, false), false);
  assertEquals(zugriffErlaubt("cashflow", {}, false), false);
  // Der Coach sieht weiterhin alles.
  assertEquals(zugriffErlaubt("cashflow", {}, true), true);
});

Deno.test("Jede Web-Ressource des Cash-Bereichs ist gegated", () => {
  // Wache gegen den Fehler, nicht gegen die eine Stelle: wer hier eine neue
  // Ressource ergaenzt, muss sie auch in RESOURCE_FEATURE eintragen.
  for (const r of ["cashflow", "stammdaten", "stammdaten_setzen"]) {
    assertEquals(typeof RESOURCE_FEATURE[r], "string", `${r} ist ungegated`);
  }
});

Deno.test("Kundensicht schraenkt ein und erweitert nie", () => {
  // Der Coach versetzt sich ausdruecklich in die Teilnehmersicht.
  assertEquals(coachZugriff(true, undefined), true);
  assertEquals(coachZugriff(true, false), true);
  assertEquals(coachZugriff(true, true), false);

  // Der entscheidende Fall: Das Flag kommt aus dem Request-Body. Ein
  // Teilnehmer, der es setzt (oder weglaesst), gewinnt dadurch NICHTS —
  // sonst waere es eine Rechteausweitung per Parameter.
  assertEquals(coachZugriff(false, true), false);
  assertEquals(coachZugriff(false, false), false);
  assertEquals(coachZugriff(false, undefined), false);

  // Nur der Wahrheitswert true schaltet um, kein "true", keine 1.
  assertEquals(coachZugriff(true, "true"), true);
  assertEquals(coachZugriff(true, 1), true);
});

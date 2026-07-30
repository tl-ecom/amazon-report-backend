import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { effektiverKorridor, pruefeKorridor, WIZARD_KENNZAHLEN } from "./strategie_wizard.ts";

Deno.test("effektiverKorridor: Override sticht Rollen-Default", () => {
  const r = effektiverKorridor({ min: 10, max: 20 }, { min: 5, max: 15 });
  assertEquals(r, { min: 10, max: 20, quelle: "override", ueberschrieben: true });
});

Deno.test("effektiverKorridor: kein Override -> Rollen-Default", () => {
  const r = effektiverKorridor(null, { min: 5, max: 15 });
  assertEquals(r, { min: 5, max: 15, quelle: "rolle", ueberschrieben: false });
});

Deno.test("effektiverKorridor: nichts gesetzt -> leer", () => {
  const r = effektiverKorridor(null, { min: null, max: null });
  assertEquals(r, { min: null, max: null, quelle: "leer", ueberschrieben: false });
});

Deno.test("effektiverKorridor: Override nur mit max zählt als Override", () => {
  const r = effektiverKorridor({ min: null, max: 30 }, { min: 5, max: 15 });
  assertEquals(r.quelle, "override");
  assertEquals(r.max, 30);
});

Deno.test("pruefeKorridor: gültige Kennzahl + min<=max ok", () => {
  assertEquals(pruefeKorridor("tacos", 10, 25), { min: 10, max: 25 });
  assertEquals(pruefeKorridor("acos", null, 30), { min: null, max: 30 });
});

Deno.test("pruefeKorridor: unbekannte Kennzahl / leer / min>max -> Fehler", () => {
  assertThrows(() => pruefeKorridor("umsatz", 1, 2)); // nicht im Wizard-Set
  assertThrows(() => pruefeKorridor("tacos", null, null));
  assertThrows(() => pruefeKorridor("tacos", 30, 10));
});

Deno.test("WIZARD_KENNZAHLEN deckt die Brief-Mindestmenge ab", () => {
  const keys = WIZARD_KENNZAHLEN.map((k) => k.kennzahl).sort();
  assertEquals(keys, ["acos", "bestandsreichweite", "cvr", "deckungsbeitrag_nach_werbung", "tacos"]);
});

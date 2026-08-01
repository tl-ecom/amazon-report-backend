import { assertEquals } from "jsr:@std/assert@1";
import { baueVersionen, tageZwischen, waehleVersionen } from "./gebuehrenaenderung_lauf.ts";

const ZEILEN = [
  { gueltig_ab: "2026-07-01", tarif: "standard" },
  { gueltig_ab: "2026-07-01", tarif: "standard" },
  { gueltig_ab: "2026-07-01", tarif: "niedrigpreis" },
  { gueltig_ab: "2026-10-01", tarif: "standard" },
  { gueltig_ab: "2026-01-01", tarif: "standard" },
];

Deno.test("baueVersionen: neuester Stand zuerst, Tarife je Stand", () => {
  const v = baueVersionen(ZEILEN, "2026-08-01");
  assertEquals(v.map((x) => x.gueltig_ab), ["2026-10-01", "2026-07-01", "2026-01-01"]);
  assertEquals(v[1].zeilen, 3);
  assertEquals(v[1].tarife, ["niedrigpreis", "standard"]);
  assertEquals(v[0].kuenftig, true);
  assertEquals(v[1].kuenftig, false);
});

Deno.test("waehleVersionen: heute gültiger Stand gegen den nächsten angekündigten", () => {
  const v = baueVersionen(ZEILEN, "2026-08-01");
  assertEquals(waehleVersionen(v, "2026-08-01"), { alt: "2026-07-01", neu: "2026-10-01" });
});

Deno.test("waehleVersionen: „alt“ ist der jüngste bereits gültige, nicht der älteste", () => {
  const v = baueVersionen(ZEILEN, "2026-08-01");
  assertEquals(waehleVersionen(v, "2026-08-01").alt, "2026-07-01");
});

Deno.test("waehleVersionen: ohne künftigen Stand gibt es nichts zu rechnen", () => {
  const v = baueVersionen(ZEILEN.filter((z) => z.gueltig_ab !== "2026-10-01"), "2026-08-01");
  assertEquals(waehleVersionen(v, "2026-08-01").neu, null);
});

Deno.test("waehleVersionen: ein gewünschter Stand sticht — auch ein vergangener", () => {
  // Damit sich auch nachträglich vergleichen lässt, was eine Änderung gebracht hat.
  const v = baueVersionen(ZEILEN, "2026-08-01");
  assertEquals(waehleVersionen(v, "2026-08-01", "2026-01-01").neu, "2026-01-01");
});

Deno.test("waehleVersionen: ein unbekannter Wunsch fällt auf den nächsten angekündigten zurück", () => {
  const v = baueVersionen(ZEILEN, "2026-08-01");
  assertEquals(waehleVersionen(v, "2026-08-01", "2099-01-01").neu, "2026-10-01");
});

Deno.test("tageZwischen: Vorlauf bis zum Stichtag, nie negativ", () => {
  assertEquals(tageZwischen("2026-08-01", "2026-10-01"), 61);
  assertEquals(tageZwischen("2026-10-01", "2026-08-01"), 0);
});

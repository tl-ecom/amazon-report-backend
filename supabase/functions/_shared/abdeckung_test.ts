// Tests für abdeckung.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Der Zweck ist, Lücken NICHT zu übersehen — und keine zu erfinden, wo
// Abrechnungen nur nicht taggenau aneinanderstossen.

import { assertEquals } from "jsr:@std/assert@1";
import { abdeckungsHinweise, abgedeckterZeitraum, findeLuecken } from "./abdeckung.ts";

function b(von: string, bis: string, id = von) {
  return { settlement_id: id, von, bis, zeilen: 100 };
}

Deno.test("Lueckenlose Abrechnungen ergeben keine Luecke", () => {
  assertEquals(findeLuecken([b("2026-06-01", "2026-06-14"), b("2026-06-15", "2026-06-28")]), []);
});

Deno.test("Fehlender Zeitraum wird mit Datum und Dauer benannt", () => {
  const l = findeLuecken([b("2026-05-01", "2026-05-07"), b("2026-06-05", "2026-06-19")]);
  assertEquals(l.length, 1);
  assertEquals(l[0].von, "2026-05-08");
  assertEquals(l[0].bis, "2026-06-04");
  assertEquals(l[0].tage, 28);
});

Deno.test("Ein bis zwei Tage Abstand gelten nicht als Luecke", () => {
  // Abrechnungen stossen selten exakt aneinander. Wer das meldet, erzeugt
  // Rauschen, das man bald ignoriert.
  assertEquals(findeLuecken([b("2026-06-01", "2026-06-14"), b("2026-06-16", "2026-06-30")]), []);
});

Deno.test("Ueberlappende Zeitraeume sind keine Luecke", () => {
  assertEquals(findeLuecken([b("2026-07-19", "2026-08-02"), b("2026-08-02", "2026-08-16")]), []);
});

Deno.test("Ein enthaltener Zeitraum verkuerzt die Reichweite nicht", () => {
  // Der dritte Bereich liegt komplett im ersten. Wer nur das jeweils letzte
  // Ende fortschreibt, meldet danach faelschlich eine Luecke.
  const l = findeLuecken([
    b("2026-02-07", "2026-05-07"),
    b("2026-03-01", "2026-03-10"),
    b("2026-05-09", "2026-05-20"),
  ]);
  assertEquals(l, []);
});

Deno.test("Unsortierte Eingabe wird korrekt ausgewertet", () => {
  const l = findeLuecken([b("2026-06-05", "2026-06-19"), b("2026-05-01", "2026-05-07")]);
  assertEquals(l.length, 1);
  assertEquals(l[0].von, "2026-05-08");
});

Deno.test("Ein einzelner Zeitraum hat keine Luecke", () => {
  assertEquals(findeLuecken([b("2026-06-01", "2026-06-14")]), []);
});

Deno.test("Abgedeckter Gesamtzeitraum ist Minimum bis Maximum", () => {
  const z = abgedeckterZeitraum([b("2026-06-05", "2026-06-19"), b("2026-02-07", "2026-05-07")]);
  assertEquals(z, { von: "2026-02-07", bis: "2026-06-19" });
});

Deno.test("Ohne Abrechnungen sagt der Hinweis das ausdruecklich", () => {
  assertEquals(abgedeckterZeitraum([]), null);
  assertEquals(abdeckungsHinweise([])[0].includes("Keine Abrechnungsdaten"), true);
});

Deno.test("Hinweis nennt Datum und Dauer, nicht nur Daten unvollstaendig", () => {
  const h = abdeckungsHinweise([b("2026-05-01", "2026-05-07"), b("2026-06-05", "2026-06-19")]);
  assertEquals(h.length, 1);
  assertEquals(h[0].includes("2026-05-08"), true);
  assertEquals(h[0].includes("28 Tage"), true);
  assertEquals(h[0].includes("zu niedrig"), true);
});

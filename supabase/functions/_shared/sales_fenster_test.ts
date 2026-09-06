// Tests für sales_fenster.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import { MAX_FENSTER_TAGE, normalisiereFenster } from "./sales_fenster.ts";

const HEUTE = new Date("2026-09-06T12:00:00Z");

Deno.test("Preset 30 Tage endet 2 Tage vor heute (Traffic-Lag) und umfasst 30 Tage", () => {
  const f = normalisiereFenster({ tage: 30 }, HEUTE);
  assertEquals(f, { von: "2026-08-06", bis: "2026-09-04", schluessel: "2026-08-06_2026-09-04" });
});

Deno.test("Preset 90 Tage ist das Maximum, mehr wird gekappt", () => {
  assertEquals(normalisiereFenster({ tage: 90 }, HEUTE).von, "2026-06-07");
  assertEquals(normalisiereFenster({ tage: 365 }, HEUTE).von, "2026-06-07");
});

Deno.test("Kalender: Ende nach dem Lag wird gekappt, Anfang auf 90 Tage davor", () => {
  const f = normalisiereFenster({ von: "2026-01-01", bis: "2026-09-06" }, HEUTE);
  assertEquals(f.bis, "2026-09-04");
  assertEquals(f.von, "2026-06-07");
});

Deno.test("Kalender: verdrehte Grenzen werden getauscht, kurzer Zeitraum bleibt", () => {
  const f = normalisiereFenster({ von: "2026-08-20", bis: "2026-08-10" }, HEUTE);
  assertEquals(f, { von: "2026-08-10", bis: "2026-08-20", schluessel: "2026-08-10_2026-08-20" });
});

Deno.test("Ohne Angabe: 30 Tage", () => {
  const f = normalisiereFenster(undefined, HEUTE);
  assertEquals(f.von, "2026-08-06");
  assertEquals(MAX_FENSTER_TAGE, 90);
});

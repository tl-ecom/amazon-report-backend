// Tests für die testbaren Teile von gebotsautomatik_lauf.ts.

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { baueAnteile, fenster } from "./gebotsautomatik_lauf.ts";

Deno.test("fenster: schneidet die Karenztage vom jüngsten Rand ab", () => {
  // 30 Tage Fenster, 3 Tage Karenz, heute ist der 17.09.
  // -> bis 14.09., von 16.08. (30 Tage inklusive).
  const f = fenster(new Date("2026-09-17T12:00:00Z"), 30, 3);
  assertEquals(f.bis, "2026-09-14");
  assertEquals(f.von, "2026-08-16");
});

Deno.test("fenster: ohne Karenz endet es heute", () => {
  const f = fenster(new Date("2026-09-17T12:00:00Z"), 7, 0);
  assertEquals(f.bis, "2026-09-17");
  assertEquals(f.von, "2026-09-11");
});

Deno.test("baueAnteile: ordnet jeder Platzierung ihren Modifier zu", () => {
  const a = baueAnteile([
    { platzierung: "Top of Search on-Amazon", klicks: 226, mod_top_prozent: 70, mod_produktseite_prozent: 0, mod_rest_prozent: 0 },
    { platzierung: "Detail Page on-Amazon", klicks: 62, mod_top_prozent: 70, mod_produktseite_prozent: 0, mod_rest_prozent: 0 },
  ]);
  assertEquals(a.length, 2);
  assertAlmostEquals(a[0].modifikator, 0.7, 1e-9);
  assertAlmostEquals(a[1].modifikator, 0, 1e-9);
  assertEquals(a[0].klicks, 226);
});

Deno.test("baueAnteile: unbekannte Platzierung bekommt Modifier 0 statt zu werfen", () => {
  const a = baueAnteile([
    { platzierung: "Off Amazon", klicks: 5, mod_top_prozent: 50, mod_produktseite_prozent: null, mod_rest_prozent: null },
  ]);
  assertEquals(a[0].modifikator, 0);
});

Deno.test("baueAnteile: fehlender Modifier zählt als 0", () => {
  const a = baueAnteile([
    { platzierung: "Top of Search on-Amazon", klicks: 10, mod_top_prozent: null },
  ]);
  assertEquals(a[0].modifikator, 0);
});

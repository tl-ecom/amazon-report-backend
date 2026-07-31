import { assertEquals } from "jsr:@std/assert@1";
import { bewerteLadenhueter } from "./ladenhueter.ts";

function inp(over: Partial<Parameters<typeof bewerteLadenhueter>[0]> = {}) {
  return {
    lifetime_units: 100, units_0_30: 10, umsatz_0_30_cents: 10000,
    units_30_120: 30, umsatz_30_120_cents: 30000, tage_ohne_verkauf: 1, ...over,
  };
}

Deno.test("zu wenig Lifetime -> ok (nie richtig gelaufen)", () => {
  const b = bewerteLadenhueter(inp({ lifetime_units: 10, tage_ohne_verkauf: 300 }));
  assertEquals(b.status, "ok");
});

Deno.test(">= 60 Tage kein Verkauf + Historie -> tot", () => {
  const b = bewerteLadenhueter(inp({ lifetime_units: 557, tage_ohne_verkauf: 154, units_0_30: 0, units_30_120: 0 }));
  assertEquals(b.status, "tot");
  assertEquals(b.schwere, 2);
});

Deno.test("Vorquartal stark, jetzt <= 30 % -> abkühlend, Einbruch berechnet", () => {
  // alt: 319 Stk/90 T = 3,54/T; neu: 6/30 = 0,2/T (<= 0,3*3,54). Umsatz alt 174000/3=58000, neu 12000 -> Einbruch 46000
  const b = bewerteLadenhueter(inp({ units_30_120: 319, umsatz_30_120_cents: 174000, units_0_30: 6, umsatz_0_30_cents: 12000, tage_ohne_verkauf: 1 }));
  assertEquals(b.status, "abkuehlend");
  assertEquals(b.schwere, 1);
  assertEquals(b.umsatz_alt_monat_cents, 58000);
  assertEquals(b.einbruch_cents, 46000);
});

Deno.test("stabiler Verkauf -> ok", () => {
  const b = bewerteLadenhueter(inp({ units_30_120: 90, units_0_30: 30, tage_ohne_verkauf: 1 }));
  assertEquals(b.status, "ok");
});

Deno.test("schwacher Rückgang, aber Vorquartal-Velocity zu niedrig -> ok", () => {
  // units_30_120 = 9 -> velo_alt 0,1 < 0,2 -> nicht abkühlend
  const b = bewerteLadenhueter(inp({ lifetime_units: 25, units_30_120: 9, units_0_30: 0, tage_ohne_verkauf: 20 }));
  assertEquals(b.status, "ok");
});

Deno.test("Ausverkauf statt Ladenhüter: lange Lücke + laeuft wieder -> wiederanlauf", () => {
  // Echter Fall B0FKNN9CCJ (VANEJA Obst-Etagere dunkelgrün): 315 Stk im Vorquartal,
  // 6 in 30 T, 28 Tage Lücke, verkauft vor 3 Tagen wieder, neue SKU.
  const b = bewerteLadenhueter(inp({
    lifetime_units: 1033, units_30_120: 315, umsatz_30_120_cents: 1560000,
    units_0_30: 6, umsatz_0_30_cents: 11991,
    tage_ohne_verkauf: 3, max_luecke_tage: 28, neue_sku: true,
  }));
  assertEquals(b.status, "wiederanlauf");
  assertEquals(b.schwere, 2);
});

Deno.test("ohne Lücke bleibt der Einbruch ein Ladenhüter (Nachfrage weg)", () => {
  const b = bewerteLadenhueter(inp({
    units_30_120: 319, units_0_30: 6, tage_ohne_verkauf: 3, max_luecke_tage: 2,
  }));
  assertEquals(b.status, "abkuehlend");
});

Deno.test("Lücke, aber immer noch nichts verkauft -> kein Wiederanlauf", () => {
  // Lücke vorhanden, laeuft aber NICHT wieder an (20 Tage ohne Verkauf) -> abkuehlend.
  const b = bewerteLadenhueter(inp({
    units_30_120: 319, units_0_30: 1, tage_ohne_verkauf: 20, max_luecke_tage: 25,
  }));
  assertEquals(b.status, "abkuehlend");
});

Deno.test("gesunde Variante bleibt unauffaellig (Schwester-ASIN schwarz)", () => {
  // B0FKNKD93K: 764 im Vorquartal, 191 in 30 T -> kein Einbruch.
  const b = bewerteLadenhueter(inp({
    lifetime_units: 1500, units_30_120: 764, units_0_30: 191, tage_ohne_verkauf: 0, max_luecke_tage: 0,
  }));
  assertEquals(b.status, "ok");
});

Deno.test("60+ Tage tot bleibt tot, auch mit Luecken-Signal", () => {
  const b = bewerteLadenhueter(inp({ lifetime_units: 557, tage_ohne_verkauf: 156, units_0_30: 0, units_30_120: 0, max_luecke_tage: 30 }));
  assertEquals(b.status, "tot");
});

Deno.test("tot schlägt abkühlend (Schwere)", () => {
  const b = bewerteLadenhueter(inp({ units_30_120: 319, units_0_30: 0, tage_ohne_verkauf: 70 }));
  assertEquals(b.status, "tot");
});

Deno.test("Einbruch nie negativ (jetzt > früher)", () => {
  const b = bewerteLadenhueter(inp({ units_30_120: 30, umsatz_30_120_cents: 3000, units_0_30: 30, umsatz_0_30_cents: 90000 }));
  assertEquals(b.einbruch_cents, 0);
});

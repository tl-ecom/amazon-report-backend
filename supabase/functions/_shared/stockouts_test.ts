import { assertEquals } from "jsr:@std/assert@1";
import { bewerteAsin } from "./stockouts.ts";

function inp(over: Partial<Parameters<typeof bewerteAsin>[0]> = {}) {
  return { velo_tag: 1, tage_ohne_verkauf: 0, avg_preis_cents: 1000, buybox_pct: null, sessions: null, ...over };
}

Deno.test("zu geringe Velocity -> ok (Nulltage sind normal)", () => {
  const b = bewerteAsin(inp({ velo_tag: 0.2, tage_ohne_verkauf: 30 }));
  assertEquals(b.status, "ok");
  assertEquals(b.verlust_cents, 0);
});

Deno.test("gute Velocity + >= 7 Tage ohne Verkauf -> leer, laufender Verlust", () => {
  const b = bewerteAsin(inp({ velo_tag: 1.5, tage_ohne_verkauf: 10, avg_preis_cents: 6879 }));
  assertEquals(b.status, "leer");
  assertEquals(b.verlust_art, "laufend");
  assertEquals(b.verlust_cents, Math.round(1.5 * 10 * 6879)); // 103185
  assertEquals(b.schwere, 3);
});

Deno.test("4–6 Tage ohne Verkauf -> kritisch (Warnung, kein Verlustwert)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 5 }));
  assertEquals(b.status, "kritisch");
  assertEquals(b.verlust_cents, 0);
  assertEquals(b.schwere, 1);
});

Deno.test("Buy-Box-Verlust bei Traffic -> buybox, Monatsrate", () => {
  // velo 1, BB 50 %, sessions 100 -> Anteil (100-50)/50 = 1 -> 1*30*1*1000 = 30000
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 1, buybox_pct: 50, sessions: 100 }));
  assertEquals(b.status, "buybox");
  assertEquals(b.verlust_art, "monatsrate");
  assertEquals(b.verlust_cents, 30000);
  assertEquals(b.schwere, 2);
});

Deno.test("leer schlägt buybox (Schwere-Reihenfolge)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 9, buybox_pct: 40, sessions: 100 }));
  assertEquals(b.status, "leer");
});

Deno.test("länger als 45 Tage tot -> ok (Ladenhüter #5, kein Stockout)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1.5, tage_ohne_verkauf: 70, avg_preis_cents: 5000 }));
  assertEquals(b.status, "ok");
  assertEquals(b.verlust_cents, 0);
});

Deno.test("hohe Buy-Box + frischer Verkauf -> ok", () => {
  const b = bewerteAsin(inp({ velo_tag: 5, tage_ohne_verkauf: 0, buybox_pct: 98, sessions: 200 }));
  assertEquals(b.status, "ok");
});

Deno.test("niedrige Buy-Box aber kaum Traffic -> ok (nicht relevant)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 1, buybox_pct: 50, sessions: 5 }));
  assertEquals(b.status, "ok");
});

Deno.test("Buy-Box-Anteil ist bei 1 gedeckelt", () => {
  // BB 10 % -> (100-10)/10 = 9, aber gedeckelt auf 1 -> velo 2 *30*1*500 = 30000
  const b = bewerteAsin(inp({ velo_tag: 2, tage_ohne_verkauf: 1, avg_preis_cents: 500, buybox_pct: 10, sessions: 50 }));
  assertEquals(b.verlust_cents, 30000);
});

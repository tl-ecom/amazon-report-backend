import { assertEquals } from "jsr:@std/assert@1";
import { aggregiereMonate } from "./kpiverlauf.ts";

Deno.test("summiert Tage zu Monaten und sortiert aufsteigend", () => {
  const m = aggregiereMonate([
    { datum: "2026-06-02", sessions: 100, page_views: 200, units_ordered: 10, units_refunded: 1, ordered_sales_cents: 50000 },
    { datum: "2026-06-15", sessions: 100, page_views: 100, units_ordered: 10, units_refunded: 0, ordered_sales_cents: 50000 },
    { datum: "2026-05-10", sessions: 50, page_views: 50, units_ordered: 5, units_refunded: 0, ordered_sales_cents: 25000 },
  ]);
  assertEquals(m.map((x) => x.monat), ["2026-05", "2026-06"]);
  const juni = m[1];
  assertEquals(juni.umsatz, 1000); // 100000 cents
  assertEquals(juni.einheiten, 20);
  assertEquals(juni.sessions, 200);
  assertEquals(juni.pageViews, 300);
});

Deno.test("CVR = Einheiten / Sessions in %", () => {
  const m = aggregiereMonate([
    { datum: "2026-06-01", sessions: 200, page_views: 0, units_ordered: 10, units_refunded: 0, ordered_sales_cents: 0 },
  ]);
  assertEquals(m[0].cvr, 5); // 10/200 = 5%
});

Deno.test("Retourenquote = Retouren / Einheiten in %", () => {
  const m = aggregiereMonate([
    { datum: "2026-06-01", sessions: 10, page_views: 0, units_ordered: 40, units_refunded: 4, ordered_sales_cents: 0 },
  ]);
  assertEquals(m[0].retourenquote, 10);
});

Deno.test("keine Division durch 0: Sessions/Einheiten 0 -> null", () => {
  const m = aggregiereMonate([
    { datum: "2026-06-01", sessions: 0, page_views: 0, units_ordered: 0, units_refunded: 0, ordered_sales_cents: 0 },
  ]);
  assertEquals(m[0].cvr, null);
  assertEquals(m[0].retourenquote, null);
});

Deno.test("null-Felder und leere Eingabe kippen nicht um", () => {
  assertEquals(aggregiereMonate([]), []);
  const m = aggregiereMonate([
    { datum: "2026-06-01", sessions: null, page_views: null, units_ordered: null, units_refunded: null, ordered_sales_cents: null },
  ]);
  assertEquals(m[0].umsatz, 0);
  assertEquals(m[0].einheiten, 0);
});

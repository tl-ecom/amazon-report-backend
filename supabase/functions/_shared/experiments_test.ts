import { assertEquals } from "jsr:@std/assert@1";
import { addTage, deltaPct, reviewDaten } from "./experiments.ts";

Deno.test("addTage rechnet über Monatsgrenzen", () => {
  assertEquals(addTage("2026-07-28", 7), "2026-08-04");
  assertEquals(addTage("2026-07-28", -30), "2026-06-28");
});

Deno.test("reviewDaten liefert 7/14/30", () => {
  assertEquals(reviewDaten("2026-07-01"), { review_7: "2026-07-08", review_14: "2026-07-15", review_30: "2026-07-31" });
});

Deno.test("deltaPct: ehrlich null bei Nenner 0", () => {
  assertEquals(deltaPct(0, 5), null);
  assertEquals(deltaPct(100, 120), 20);
  assertEquals(deltaPct(100, 80), -20);
});

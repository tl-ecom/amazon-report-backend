import { assertEquals } from "jsr:@std/assert@1";
import { type Adjustment, findeAnspruchskandidaten, type Reimbursement } from "./reimbursements.ts";

function adj(asin: string, quantity: number, datum = "2026-06-01", reason = "M"): Adjustment {
  return { asin, quantity, datum, reason };
}
function reimb(asin: string | null, qty: number, cents: number): Reimbursement {
  return { asin, quantity_total: qty, amount_total_cents: cents, approval_date: "2026-06-10" };
}

Deno.test("Verlust ohne Erstattung -> Kandidat, Wert aus Preis-Fallback", () => {
  const r = findeAnspruchskandidaten([adj("B01", -3)], [], { B01: 1000 });
  assertEquals(r.kandidaten.length, 1);
  const k = r.kandidaten[0];
  assertEquals(k.offen_einheiten, 3);
  assertEquals(k.satz_quelle, "preis");
  assertEquals(k.satz_cents, 1000);
  assertEquals(k.geschaetzt_cents, 3000);
  assertEquals(r.summe_geschaetzt_cents, 3000);
});

Deno.test("Fund hebt Verlust auf (netto 0) -> kein Kandidat", () => {
  const r = findeAnspruchskandidaten([adj("B01", -3), adj("B01", 3)], []);
  assertEquals(r.kandidaten.length, 0);
  assertEquals(r.anzahl_verlust_events, 1);
});

Deno.test("teilweise erstattet -> Kandidat fuer Rest, Satz aus Erstattung", () => {
  // 5 verloren, 2 erstattet (à 4,00 €) -> 3 offen, Satz 400 -> 12,00 €
  const r = findeAnspruchskandidaten([adj("B01", -5)], [reimb("B01", 2, 800)]);
  const k = r.kandidaten[0];
  assertEquals(k.netto_verlust, 5);
  assertEquals(k.erstattet_einheiten, 2);
  assertEquals(k.offen_einheiten, 3);
  assertEquals(k.satz_quelle, "erstattung");
  assertEquals(k.satz_cents, 400);
  assertEquals(k.geschaetzt_cents, 1200);
});

Deno.test("voll erstattet -> kein Kandidat", () => {
  const r = findeAnspruchskandidaten([adj("B01", -4)], [reimb("B01", 4, 1600)]);
  assertEquals(r.kandidaten.length, 0);
  assertEquals(r.erstattet_gesamt_cents, 1600);
});

Deno.test("erstattet_gesamt zaehlt auch Erstattungen ohne ASIN", () => {
  const r = findeAnspruchskandidaten([], [reimb(null, 1, 500), reimb("B02", 1, 300)]);
  assertEquals(r.erstattet_gesamt_cents, 800);
});

Deno.test("ohne Satz/Preis -> Kandidat ohne Wert, in kandidaten_ohne_wert", () => {
  const r = findeAnspruchskandidaten([adj("B01", -2)], []);
  assertEquals(r.kandidaten[0].geschaetzt_cents, null);
  assertEquals(r.kandidaten[0].satz_quelle, null);
  assertEquals(r.kandidaten_ohne_wert, 2);
  assertEquals(r.summe_geschaetzt_cents, 0);
});

Deno.test("Sortierung: wertvollster Kandidat zuerst", () => {
  const r = findeAnspruchskandidaten(
    [adj("KLEIN", -1), adj("GROSS", -2)],
    [reimb("KLEIN", 0, 0), reimb("GROSS", 0, 0)],
    { KLEIN: 500, GROSS: 5000 },
  );
  assertEquals(r.kandidaten[0].asin, "GROSS");
  assertEquals(r.kandidaten[0].geschaetzt_cents, 10000);
});

import { assertEquals } from "jsr:@std/assert@1";
import { baueZuordnungRow, berechneReviewFaellig } from "./strategie_flow.ts";

Deno.test("berechneReviewFaellig: Override gewinnt", () => {
  assertEquals(berechneReviewFaellig("2026-07-01", 30, "2026-09-15"), "2026-09-15");
});

Deno.test("berechneReviewFaellig: sonst heute + max_dauer_tage", () => {
  assertEquals(berechneReviewFaellig("2026-07-01", 30), "2026-07-31");
});

Deno.test("berechneReviewFaellig: keine Frist & kein Override → null", () => {
  assertEquals(berechneReviewFaellig("2026-07-01", null), null);
  assertEquals(berechneReviewFaellig("2026-07-01", 0), null);
  // ungültiger Override wird ignoriert → fällt auf Frist zurück
  assertEquals(berechneReviewFaellig("2026-07-01", 10, "quatsch"), "2026-07-11");
});

Deno.test("baueZuordnungRow: Annahme eines Vorschlags erbt Begründung/Confidence/Basis", () => {
  const row = baueZuordnungRow({
    tenant_id: "t1", asin: "B01", rolle: "scale", quelle: "suggested",
    user_id: "u1", now: "2026-07-01T00:00:00.000Z", review: "2026-08-01",
    vorschlag: { konfidenz: "high", begruendung: "wächst", basis: { umsatz_trend: 0.4 } },
    notiz: "ok",
  });
  assertEquals(row.rolle, "scale");
  assertEquals(row.quelle, "suggested");
  assertEquals(row.gueltig_bis, null);
  assertEquals(row.bestaetigt_von, "u1");
  assertEquals(row.review_faellig, "2026-08-01");
  assertEquals(row.konfidenz, "high");
  assertEquals(row.begruendung, "wächst");
  assertEquals(row.basis, { umsatz_trend: 0.4 });
  assertEquals(row.notiz, "ok");
});

Deno.test("baueZuordnungRow: manuelles Überschreiben ohne Vorschlag → Confidence/Basis null", () => {
  const row = baueZuordnungRow({
    tenant_id: "t1", asin: "B01", rolle: "exit", quelle: "confirmed",
    user_id: "u1", now: "2026-07-01T00:00:00.000Z", review: null,
  });
  assertEquals(row.quelle, "confirmed");
  assertEquals(row.konfidenz, null);
  assertEquals(row.begruendung, null);
  assertEquals(row.basis, null);
  assertEquals(row.review_faellig, null);
});

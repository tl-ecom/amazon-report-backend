import { assertEquals } from "jsr:@std/assert@1";
import { type AsinAgg, baueSnapshot, wochenausgabe } from "./strategie_lauf.ts";
import type { Finding } from "./strategie.ts";

function agg(over: Partial<AsinAgg> = {}): AsinAgg {
  return {
    asin: "B01", produktname: "P", erstmals_gesehen: "2025-01-01",
    umsatz: 1000, einheiten: 100, rohertrag: 300,
    umsatz_vorperiode: 800, portfolio_umsatz: 4000, ...over,
  };
}

Deno.test("baueSnapshot: DB/Stück, Portfolio-Anteil und Trend korrekt", () => {
  const s = baueSnapshot(agg(), "2026-07-01");
  assertEquals(s.kennzahlen.deckungsbeitrag_stueck, 3);   // 300/100
  assertEquals(s.kennzahlen.umsatzanteil_portfolio, 25);  // 1000/4000
  assertEquals(s.umsatz_trend, 0.25);                     // (1000-800)/800
  assertEquals(s.kennzahlen.umsatz, 1000);
});

Deno.test("baueSnapshot: fehlende Werte → null (nicht 0)", () => {
  const s = baueSnapshot(agg({ rohertrag: null, umsatz_vorperiode: null, portfolio_umsatz: 0 }), "2026-07-01");
  assertEquals(s.kennzahlen.deckungsbeitrag_stueck, null); // kein EK
  assertEquals(s.umsatz_trend, null);                      // keine Vorperiode
  assertEquals(s.kennzahlen.umsatzanteil_portfolio, null); // kein Portfolio-Umsatz
});

Deno.test("baueSnapshot: erstmals_gesehen wird durchgereicht (Produktalter-Quelle)", () => {
  const s = baueSnapshot(agg({ erstmals_gesehen: "2026-06-01" }), "2026-07-01");
  assertEquals(s.erstmals_gesehen, "2026-06-01");
});

function f(over: Partial<Finding> = {}): Finding {
  return { kennzahl: "acos", severity: "mittel", ist_wert: 40, abweichung: "x", magnitude: 1, erster_ort_zum_suchen: "y", rang: 1, ...over };
}

Deno.test("wochenausgabe: max 3 über alle ASINs, review zuerst, dann Severity", () => {
  const out = wochenausgabe([
    { asin: "A", produktname: "a", findings: [f({ severity: "niedrig", magnitude: 0.1 })] },
    { asin: "B", produktname: "b", findings: [f({ kennzahl: "review", severity: "mittel", magnitude: 5 })] },
    { asin: "C", produktname: "c", findings: [f({ severity: "hoch", magnitude: 2 }), f({ severity: "mittel", magnitude: 3 })] },
  ]);
  assertEquals(out.length, 3);
  assertEquals(out[0].kennzahl, "review"); // Entscheidungs-Ereignis zuerst
  assertEquals(out[0].asin, "B");
  assertEquals(out[1].severity, "hoch");   // dann höchste Severity
  assertEquals(out[2].severity, "mittel");
});

Deno.test("wochenausgabe: keine Findings → leer", () => {
  assertEquals(wochenausgabe([{ asin: "A", produktname: "a", findings: [] }]).length, 0);
});

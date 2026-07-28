import { assertEquals } from "jsr:@std/assert@1";
import {
  type AktiveStrategie,
  type AsinSnapshot,
  evaluate,
  vorschlagRolle,
  wochenSeit,
} from "./strategie.ts";
import type { StrategieDefinition, VorschlagSchwellen } from "../../../config/strategy-definitions.ts";

// --- Fixtures (Zahlen NUR im Test — der Produktivcode bleibt zahlfrei) ---

const SCHWELLEN: VorschlagSchwellen = {
  launch_max_alter_wochen: 8,
  reif_ab_wochen: 26,
  scale_min_umsatz_trend: 0.2,
  schrumpf_umsatz_trend: -0.2,
  scale_min_reichweite_tage: 21,
  db_stueck_positiv_ab: 0,
};

function snap(over: Partial<AsinSnapshot> = {}): AsinSnapshot {
  return {
    asin: "B01",
    stichtag: "2026-07-01",
    kennzahlen: {},
    erstmals_gesehen: null,
    ...over,
  };
}

// Aktive „hold"-Strategie: leading_kpi acos, Korridor nur nach oben (≤ 30 %),
// bestandsreichweite gemutet, eine Zusatzregel auf cvr.
const HOLD_DEF: StrategieDefinition = {
  rolle: "hold",
  leading_kpi: "acos",
  korridor: { min: null, max: 30 },
  alert_regeln: [
    { kennzahl: "cvr", richtung: "unter", schwelle: 5, severity: "hoch", erster_ort_zum_suchen: "Listing/Content prüfen." },
  ],
  muted_metrics: ["bestandsreichweite"],
  max_dauer_tage: null,
  beschreibung: "hold",
};

const AKTIV_HOLD: AktiveStrategie = { rolle: "hold", gueltig_ab: "2026-01-01", review_faellig: null };

// --- wochenSeit ---

Deno.test("wochenSeit: rechnet ganze Wochen; null bei fehlendem Datum", () => {
  assertEquals(wochenSeit("2026-06-01", "2026-06-15"), 2);
  assertEquals(wochenSeit(null, "2026-06-15"), null);
});

// --- vorschlagRolle: ein Test je Rolle ---

Deno.test("vorschlagRolle: junges Produkt → launch", () => {
  const v = vorschlagRolle(snap({ erstmals_gesehen: "2026-06-01", umsatz_trend: 0.5, kennzahlen: { deckungsbeitrag_stueck: 2 } }), SCHWELLEN);
  assertEquals(v.rolle, "launch");
  assertEquals(v.konfidenz, "high");
  assertEquals(v.offene_frage, false);
});

Deno.test("vorschlagRolle: wächst, profitabel, Bestand → scale", () => {
  const v = vorschlagRolle(snap({
    erstmals_gesehen: "2025-01-01",
    umsatz_trend: 0.4,
    kennzahlen: { deckungsbeitrag_stueck: 3, bestandsreichweite: 40 },
  }), SCHWELLEN);
  assertEquals(v.rolle, "scale");
  assertEquals(v.konfidenz, "high");
});

Deno.test("vorschlagRolle: reif, stabil, profitabel → hold (Default)", () => {
  const v = vorschlagRolle(snap({
    erstmals_gesehen: "2025-01-01",
    umsatz_trend: 0.0,
    kennzahlen: { deckungsbeitrag_stueck: 2 },
  }), SCHWELLEN);
  assertEquals(v.rolle, "hold");
});

Deno.test("vorschlagRolle: rückläufig, aber profitabel → harvest", () => {
  const v = vorschlagRolle(snap({
    erstmals_gesehen: "2024-01-01",
    umsatz_trend: -0.3,
    kennzahlen: { deckungsbeitrag_stueck: 1.5 },
  }), SCHWELLEN);
  assertEquals(v.rolle, "harvest");
});

Deno.test("vorschlagRolle: unprofitabel UND rückläufig → exit", () => {
  const v = vorschlagRolle(snap({
    erstmals_gesehen: "2024-01-01",
    umsatz_trend: -0.4,
    kennzahlen: { deckungsbeitrag_stueck: -1 },
  }), SCHWELLEN);
  assertEquals(v.rolle, "exit");
});

// --- Pflichtfall: low confidence → offene Frage (nicht still zuweisen) ---

Deno.test("vorschlagRolle: Alter UND Umsatztrend unbekannt → low confidence, offene Frage", () => {
  const v = vorschlagRolle(snap({ erstmals_gesehen: null, umsatz_trend: null, kennzahlen: { deckungsbeitrag_stueck: 1 } }), SCHWELLEN);
  assertEquals(v.konfidenz, "low");
  assertEquals(v.offene_frage, true);
});

// --- evaluate: im Korridor → kein Handlungsbedarf ---

Deno.test("evaluate: leading im Korridor → kein Handlungsbedarf, keine Findings", () => {
  const r = evaluate(snap({ kennzahlen: { acos: 22, cvr: 9 } }), AKTIV_HOLD, HOLD_DEF, "2026-07-02");
  assertEquals(r.beobachtung.ergebnis, "im_korridor");
  assertEquals(r.kein_handlungsbedarf, true);
  assertEquals(r.findings.length, 0);
});

// --- evaluate: leading verlässt Korridor → Finding ---

Deno.test("evaluate: acos über Korridor → ausserhalb + Finding", () => {
  const r = evaluate(snap({ kennzahlen: { acos: 45, cvr: 9 } }), AKTIV_HOLD, HOLD_DEF, "2026-07-02");
  assertEquals(r.beobachtung.ergebnis, "ausserhalb");
  assertEquals(r.findings.length, 1);
  assertEquals(r.findings[0].kennzahl, "acos");
  assertEquals(r.kein_handlungsbedarf, false);
});

// --- Pflichtfall: gemutete Kennzahl reißt den Korridor → verworfen ---

Deno.test("evaluate: gemutete Kennzahl (bestandsreichweite) reißt Regel → verworfen", () => {
  const def: StrategieDefinition = {
    ...HOLD_DEF,
    alert_regeln: [
      { kennzahl: "bestandsreichweite", richtung: "unter", schwelle: 14, severity: "hoch", erster_ort_zum_suchen: "Nachschub." },
    ],
  };
  // acos im Korridor, aber bestandsreichweite weit unter Schwelle — muss trotzdem NICHTS melden.
  const r = evaluate(snap({ kennzahlen: { acos: 20, bestandsreichweite: 2 } }), AKTIV_HOLD, def, "2026-07-02");
  assertEquals(r.findings.length, 0);
  assertEquals(r.kein_handlungsbedarf, true);
});

// --- Pflichtfall: Rolle abgelaufen (review fällig) → meldepflichtiges Ereignis ---

Deno.test("evaluate: review_faellig erreicht → review-Finding, priorisiert vorn", () => {
  const aktiv: AktiveStrategie = { rolle: "launch", gueltig_ab: "2026-04-01", review_faellig: "2026-06-15" };
  const def: StrategieDefinition = { ...HOLD_DEF, rolle: "launch" };
  const r = evaluate(snap({ kennzahlen: { acos: 45 } }), aktiv, def, "2026-07-02");
  // review + acos-Bruch → review muss Rang 1 sein.
  assertEquals(r.findings[0].kennzahl, "review");
  assertEquals(r.findings[0].rang, 1);
});

// --- max_dauer_tage abgelaufen → auch ohne review_faellig ein Ereignis ---

Deno.test("evaluate: max_dauer_tage überschritten → review-Finding", () => {
  const aktiv: AktiveStrategie = { rolle: "launch", gueltig_ab: "2026-01-01", review_faellig: null };
  const r = evaluate(snap({ kennzahlen: { acos: 20 } }), aktiv, { ...HOLD_DEF, rolle: "launch" }, "2026-07-02", 60);
  assertEquals(r.findings.some((f) => f.kennzahl === "review"), true);
});

// --- nicht konfigurierte Strategie → nicht bewertbar, keine erfundenen Findings ---

Deno.test("evaluate: unvollständige Definition → nicht_bewertbar + Hinweis, keine Findings", () => {
  const leer: StrategieDefinition = { rolle: "hold", leading_kpi: null, korridor: { min: null, max: null }, alert_regeln: [], muted_metrics: [], max_dauer_tage: null, beschreibung: "" };
  const r = evaluate(snap({ kennzahlen: { acos: 99 } }), AKTIV_HOLD, leer, "2026-07-02");
  assertEquals(r.beobachtung.ergebnis, "nicht_bewertbar");
  assertEquals(r.findings.length, 0);
  assertEquals(typeof r.hinweis, "string");
  assertEquals(r.kein_handlungsbedarf, false);
});

// --- unbekannte leading-Kennzahl → nicht bewertbar (null ≠ 0) ---

Deno.test("evaluate: leading-Kennzahl unbekannt → nicht_bewertbar", () => {
  const r = evaluate(snap({ kennzahlen: {} }), AKTIV_HOLD, HOLD_DEF, "2026-07-02");
  assertEquals(r.beobachtung.ergebnis, "nicht_bewertbar");
  assertEquals(r.beobachtung.leading_wert, null);
});

// --- Kürzen auf 3, aber findings_gesamt bleibt sichtbar ---

Deno.test("evaluate: mehr als 3 Findings → auf 3 gekürzt, findings_gesamt zeigt Gesamtzahl", () => {
  const def: StrategieDefinition = {
    ...HOLD_DEF,
    alert_regeln: [
      { kennzahl: "cvr", richtung: "unter", schwelle: 5, severity: "hoch", erster_ort_zum_suchen: "a" },
      { kennzahl: "tacos", richtung: "ueber", schwelle: 20, severity: "mittel", erster_ort_zum_suchen: "b" },
      { kennzahl: "umsatz", richtung: "unter", schwelle: 100, severity: "niedrig", erster_ort_zum_suchen: "c" },
    ],
  };
  const aktiv: AktiveStrategie = { rolle: "hold", gueltig_ab: "2026-01-01", review_faellig: "2026-06-01" };
  // review + acos-Bruch + 3 Regeln = 5 Findings.
  const r = evaluate(snap({ kennzahlen: { acos: 50, cvr: 2, tacos: 40, umsatz: 50 } }), aktiv, def, "2026-07-02");
  assertEquals(r.findings.length, 3);
  assertEquals(r.findings_gesamt, 5);
  assertEquals(r.findings[0].kennzahl, "review"); // Entscheidungs-Ereignis zuerst
});

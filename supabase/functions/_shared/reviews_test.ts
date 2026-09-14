// Tests für reviews.ts.
//
// Die Fixtures bilden die Antwortform der Customer-Feedback-API nach
// (v2024-06-01): Themen mit Metriken je Ebene (ASIN, Parent, Kategorie), dazu
// der Monatsverlauf. Geprüft wird vor allem, was NICHT passieren darf —
// erfundene Nullen und Alarm bei Zufall.

import { assertEquals } from "jsr:@std/assert@1";
import {
  auffaelligeThemen, FAKTOR_WARN, GRENZEN, NENNUNGEN_MIN,
  parseThemen, parseTrend, type TrendPunkt,
} from "./reviews.ts";

const THEMEN_ANTWORT = {
  positiveTopics: [{
    topic: "Sturdy",
    asinMetrics: { mentions: 48, occurrencePercentage: 12.4, starRatingImpact: 0.31 },
    parentAsinMetrics: { occurrencePercentage: 11.0 },
    browseNodeMetrics: { occurrencePercentage: 6.2 },
    reviewSnippets: ["very sturdy", "feels solid"],
    subtopics: [{ topic: "Stable base", mentions: 12 }],
  }],
  negativeTopics: [{
    topic: "Packaging",
    asinMetrics: { mentions: 19, occurrencePercentage: 4.9, starRatingImpact: -0.42 },
    parentAsinMetrics: { occurrencePercentage: 5.1 },
    browseNodeMetrics: { occurrencePercentage: 1.8 },
    reviewSnippets: ["arrived crushed"],
  }],
};

Deno.test("Themen: Metriken je Ebene, Richtung getrennt", () => {
  const z = parseThemen(THEMEN_ANTWORT);
  assertEquals(z.length, 2);

  const gut = z.find((x) => x.thema === "Sturdy")!;
  assertEquals(gut.richtung, "positiv");
  assertEquals(gut.nennungen, 48);
  assertEquals(gut.anteil, 12.4);
  assertEquals(gut.stern_einfluss, 0.31);

  const schlecht = z.find((x) => x.thema === "Packaging")!;
  assertEquals(schlecht.richtung, "negativ");
  // Der Vergleich zur Kategorie ist der eigentliche Wert: 4,9 % gegen 1,8 %
  // heisst, das Problem ist hier groesser als ueblich.
  assertEquals(schlecht.anteil, 4.9);
  assertEquals(schlecht.anteil_kategorie, 1.8);
  assertEquals(schlecht.stern_einfluss, -0.42);
});

Deno.test("Themen: unbekanntes Feld wird null, nicht 0", () => {
  // "kein Einfluss auf die Sterne" und "Feld nicht gefunden" sind verschiedene
  // Aussagen. Eine 0 wuerde die zweite als die erste ausgeben.
  const z = parseThemen({
    negativeTopics: [{ topic: "Smell", asinMetrics: { mentions: 7 } }],
  });
  assertEquals(z[0].nennungen, 7);
  assertEquals(z[0].stern_einfluss, null);
  assertEquals(z[0].anteil, null);
  assertEquals(z[0].anteil_kategorie, null);
});

Deno.test("Themen: Rohantwort bleibt erhalten", () => {
  // Die Feldnamen der API sind nur teilweise dokumentiert. Was der Parser
  // heute nicht erkennt, muss nachtraeglich auswertbar bleiben.
  const z = parseThemen(THEMEN_ANTWORT);
  assertEquals((z[0].roh as any).topic, "Sturdy");
  assertEquals((z[0].unterthemen as any[])[0].topic, "Stable base");
});

Deno.test("Themen: ohne Themenname keine Zeile", () => {
  const z = parseThemen({ negativeTopics: [{ asinMetrics: { mentions: 9 } }, { topic: "  " }] });
  assertEquals(z.length, 0);
});

const TREND_ANTWORT = {
  negativeTopics: [{
    topic: "Packaging",
    trendMetrics: [
      { dateRange: { startDate: "2026-07-01", endDate: "2026-07-31" }, asinMetrics: { occurrencePercentage: 2.1 } },
      { dateRange: { startDate: "2026-08-01", endDate: "2026-08-31" }, asinMetrics: { occurrencePercentage: 4.9 },
        browseNodeMetrics: { occurrencePercentage: 1.8 } },
    ],
  }],
};

Deno.test("Trend: eine Zeile je Thema und Zeitraum", () => {
  const t = parseTrend(TREND_ANTWORT);
  assertEquals(t.length, 2);
  assertEquals(t[0].monat, "2026-07-01");
  assertEquals(t[0].anteil, 2.1);
  assertEquals(t[1].monat, "2026-08-01");
  assertEquals(t[1].bis, "2026-08-31");
  assertEquals(t[1].anteil_kategorie, 1.8);
  assertEquals(t[1].richtung, "negativ");
});

Deno.test("Trend: Punkt ohne Datum wird verworfen, nicht geraten", () => {
  const t = parseTrend({
    negativeTopics: [{ topic: "Smell", trendMetrics: [{ asinMetrics: { occurrencePercentage: 3 } }] }],
  });
  assertEquals(t.length, 0);
});

// --- Diagnose ---------------------------------------------------------------

function reihe(...anteile: Array<number | null>): TrendPunkt[] {
  return anteile.map((a, i) => ({ monat: `2026-0${i + 4}-01`, anteil: a }));
}

Deno.test("Diagnose: neues Thema wird gemeldet", () => {
  const a = auffaelligeThemen(
    new Map([["Packaging", reihe(0, 4.9)]]),
    new Map([["Packaging", 19]]),
  );
  assertEquals(a.length, 1);
  assertEquals(a[0].art, "neu");
  assertEquals(a[0].nennungen, 19);
  assertEquals(a[0].begruendung.includes("neu auf"), true);
});

Deno.test("Diagnose: Verdopplung wird gemeldet, mit Vorbehalt", () => {
  const a = auffaelligeThemen(
    new Map([["Packaging", reihe(2.1, 4.9)]]),
    new Map([["Packaging", 19]]),
  );
  assertEquals(a[0].art, "verdoppelt");
  assertEquals(a[0].faktor, 2.33);
  // Beobachtung, nicht Ursache — der Satz muss dranstehen.
  assertEquals(a[0].begruendung.includes("keine"), true);
  assertEquals(a[0].begruendung.includes("Ursache"), true);
});

Deno.test("Diagnose: kleine Zahlen loesen keinen Alarm aus", () => {
  // Von 2 auf 4 Nennungen ist eine Verdopplung und bedeutet nichts. Bei zwanzig
  // Themen je ASIN passiert das jede Woche irgendwo — und wer jede Woche Zufall
  // gemeldet bekommt, liest die Meldung nicht mehr.
  const a = auffaelligeThemen(
    new Map([["Smell", reihe(1.0, 2.2)]]),
    new Map([["Smell", 4]]),
  );
  assertEquals(a, []);
  assertEquals(NENNUNGEN_MIN, 5);
  assertEquals(FAKTOR_WARN, 2);
});

Deno.test("Diagnose: ohne Nennungen wird nicht gemeldet", () => {
  // Ein Prozentsprung ohne Mengenangabe ist nicht einzuordnen. Unbekannt gilt
  // nicht als gross genug.
  const a = auffaelligeThemen(
    new Map([["Smell", reihe(1.0, 9.0)]]),
    new Map([["Smell", null]]),
  );
  assertEquals(a, []);
});

Deno.test("Diagnose: ein einzelner Monat ist kein Trend", () => {
  const a = auffaelligeThemen(new Map([["Smell", reihe(9.0)]]), new Map([["Smell", 40]]));
  assertEquals(a, []);
});

Deno.test("Diagnose: leichter Anstieg bleibt still", () => {
  const a = auffaelligeThemen(
    new Map([["Packaging", reihe(4.0, 5.2)]]),
    new Map([["Packaging", 30]]),
  );
  assertEquals(a, []);
});

Deno.test("Grenzen werden mitgeliefert, nicht vorausgesetzt", () => {
  // Ohne diese Saetze liest jemand die Themen als Rezensionsauswertung und
  // sucht die Sterne.
  assertEquals(GRENZEN.some((g) => g.includes("ENGLISCH")), true);
  assertEquals(GRENZEN.some((g) => g.includes("WÖCHENTLICH")), true);
  assertEquals(GRENZEN.some((g) => g.includes("Sternezahl")), true);
  assertEquals(GRENZEN.some((g) => g.includes("Marktplatz")), true);
});

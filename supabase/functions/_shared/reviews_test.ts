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

// Form aus dem ECHTEN Abruf (Vanejas Biomuelleimer, 14.09.2026). Drei Dinge
// weichen von der Doku ab, und alle drei haetten stillschweigend null ergeben:
// die Themen stecken unter `topics`, die Nennungen heissen `numberOfMentions`,
// und auf Kategorieebene ist occurrencePercentage ein OBJEKT mit `allProducts`.
const THEMEN_ANTWORT = {
  asin: "B0D7D2NMT4",
  topics: {
    positiveTopics: [{
      topic: "Stabilität",
      asinMetrics: { numberOfMentions: 48, occurrencePercentage: 12.4, starRatingImpact: 0.31 },
      parentAsinMetrics: { occurrencePercentage: 11.0 },
      browseNodeMetrics: { occurrencePercentage: { allProducts: 6.2 } },
      reviewSnippets: ["sehr stabil", "wirkt solide"],
      subtopics: [{ topic: "Standfestigkeit", numberOfMentions: 12 }],
    }],
    negativeTopics: [{
      topic: "Geruch",
      asinMetrics: { numberOfMentions: 19, occurrencePercentage: 4.9, starRatingImpact: -0.42 },
      parentAsinMetrics: { occurrencePercentage: 5.1 },
      browseNodeMetrics: { occurrencePercentage: { allProducts: 1.8 } },
      reviewSnippets: ["stinkende Brühe"],
    }],
  },
};

Deno.test("Themen: Metriken je Ebene, Richtung getrennt", () => {
  const z = parseThemen(THEMEN_ANTWORT);
  assertEquals(z.length, 2);

  const gut = z.find((x) => x.thema === "Stabilität")!;
  assertEquals(gut.richtung, "positiv");
  assertEquals(gut.nennungen, 48);
  assertEquals(gut.anteil, 12.4);
  assertEquals(gut.stern_einfluss, 0.31);

  const schlecht = z.find((x) => x.thema === "Geruch")!;
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
    topics: { negativeTopics: [{ topic: "Geruch", asinMetrics: { numberOfMentions: 7 } }] },
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
  assertEquals((z[0].roh as any).topic, "Stabilität");
  assertEquals((z[0].unterthemen as any[])[0].topic, "Standfestigkeit");
});

Deno.test("Themen: ohne Themenname keine Zeile", () => {
  const z = parseThemen({ topics: { negativeTopics: [{ asinMetrics: { numberOfMentions: 9 } }, { topic: "  " }] } });
  assertEquals(z.length, 0);
});

const TREND_ANTWORT = {
  topics: { negativeTopics: [{
    topic: "Packaging",
    trendMetrics: [
      { dateRange: { startDate: "2026-07-01", endDate: "2026-07-31" }, asinMetrics: { occurrencePercentage: 2.1 } },
      { dateRange: { startDate: "2026-08-01", endDate: "2026-08-31" }, asinMetrics: { occurrencePercentage: 4.9 },
        browseNodeMetrics: { occurrencePercentage: { allProducts: 1.8 } } },
    ],
  }] },
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
    topics: { negativeTopics: [{ topic: "Geruch", trendMetrics: [{ asinMetrics: { occurrencePercentage: 3 } }] }] },
  });
  assertEquals(t.length, 0);
});

// --- Diagnose ---------------------------------------------------------------

function reihe(...anteile: Array<number | null>): TrendPunkt[] {
  return anteile.map((a, i) => ({ monat: `2026-0${i + 4}-01`, anteil: a }));
}

Deno.test("Diagnose: neues Thema wird gemeldet", () => {
  const a = auffaelligeThemen(
    new Map([["Geruch", reihe(0, 4.9)]]),
    new Map([["Geruch", 19]]),
  );
  assertEquals(a.length, 1);
  assertEquals(a[0].art, "neu");
  assertEquals(a[0].nennungen, 19);
  assertEquals(a[0].begruendung.includes("neu auf"), true);
});

Deno.test("Diagnose: Verdopplung wird gemeldet, mit Vorbehalt", () => {
  const a = auffaelligeThemen(
    new Map([["Geruch", reihe(2.1, 4.9)]]),
    new Map([["Geruch", 19]]),
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
    new Map([["Handhabung", reihe(1.0, 2.2)]]),
    new Map([["Handhabung", 4]]),
  );
  assertEquals(a, []);
  assertEquals(NENNUNGEN_MIN, 5);
  assertEquals(FAKTOR_WARN, 2);
});

Deno.test("Diagnose: ohne Nennungen wird nicht gemeldet", () => {
  // Ein Prozentsprung ohne Mengenangabe ist nicht einzuordnen. Unbekannt gilt
  // nicht als gross genug.
  const a = auffaelligeThemen(
    new Map([["Handhabung", reihe(1.0, 9.0)]]),
    new Map([["Handhabung", null]]),
  );
  assertEquals(a, []);
});

Deno.test("Diagnose: ein einzelner Monat ist kein Trend", () => {
  const a = auffaelligeThemen(new Map([["Handhabung", reihe(9.0)]]), new Map([["Handhabung", 40]]));
  assertEquals(a, []);
});

Deno.test("Diagnose: leichter Anstieg bleibt still", () => {
  const a = auffaelligeThemen(
    new Map([["Geruch", reihe(4.0, 5.2)]]),
    new Map([["Geruch", 30]]),
  );
  assertEquals(a, []);
});

Deno.test("Grenzen werden mitgeliefert, nicht vorausgesetzt", () => {
  // Ohne diese Saetze liest jemand die Themen als Rezensionsauswertung und
  // sucht die Sterne.
  // Am echten Abruf gemessen: Amazon liefert DEUTSCH, obwohl die Doku
  // "nur Englisch" sagt.
  assertEquals(GRENZEN.some((g) => g.includes("DEUTSCH")), true);
  assertEquals(GRENZEN.some((g) => g.includes("WÖCHENTLICH")), true);
  assertEquals(GRENZEN.some((g) => g.includes("Sternezahl")), true);
  assertEquals(GRENZEN.some((g) => g.includes("Marktplatz")), true);
  // Ein Wert, der noch nicht verstanden ist, darf nicht als Kennzahl
  // durchgehen — lieber der Vorbehalt als eine plausible Fehlinterpretation.
  assertEquals(GRENZEN.some((g) => g.includes("NOCH NICHT bestätigt")), true);
});

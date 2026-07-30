import { assertEquals } from "jsr:@std/assert@1";
import { analysiereZeitraum, baueOrdersUmsatz } from "./verlauf.ts";

// Hilfsfunktion: alle Tage von..bis (inklusiv) erzeugen.
function tage(von: string, bis: string): string[] {
  const raus: string[] = [];
  const d = new Date(von + "T00:00:00Z");
  const end = new Date(bis + "T00:00:00Z");
  while (d.getTime() <= end.getTime()) {
    raus.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return raus;
}

Deno.test("vollständiger Zeitraum -> nicht provisional, keine Lücken", () => {
  const r = analysiereZeitraum("2026-07-01", "2026-07-30", tage("2026-07-01", "2026-07-30"));
  assertEquals(r.is_provisional, false);
  assertEquals(r.fehlende_tage_anzahl, 0);
  assertEquals(r.tage_mit_daten, 30);
  assertEquals(r.verfuegbar, { von: "2026-07-01", bis: "2026-07-30" });
  assertEquals(r.latest_available_date, "2026-07-30");
  assertEquals(r.warnungen, []);
});

Deno.test("fehlende Tage am Ende (Amazon-Verzug) -> provisional + Warnung", () => {
  // Genau der Vaneja-Fall: Daten nur bis 28., angefragt bis 30.
  const r = analysiereZeitraum("2026-07-01", "2026-07-30", tage("2026-07-01", "2026-07-28"));
  assertEquals(r.is_provisional, true);
  assertEquals(r.tage_mit_daten, 28);
  assertEquals(r.latest_available_date, "2026-07-28");
  assertEquals(r.verfuegbar, { von: "2026-07-01", bis: "2026-07-28" });
  assertEquals(r.fehlende_tage, ["2026-07-29", "2026-07-30"]);
  assertEquals(r.fehlende_tage_anzahl, 2);
  assertEquals(r.warnungen.length, 1);
});

Deno.test("fehlende Tage MITTEN im Zeitraum -> Datenlücken-Warnung", () => {
  const vorhanden = tage("2026-07-01", "2026-07-30").filter((t) => t !== "2026-07-10" && t !== "2026-07-11");
  const r = analysiereZeitraum("2026-07-01", "2026-07-30", vorhanden);
  assertEquals(r.is_provisional, true);
  assertEquals(r.fehlende_tage, ["2026-07-10", "2026-07-11"]);
  assertEquals(r.fehlende_tage_anzahl, 2);
  // verfügbarer Zeitraum bleibt 01..30 (Ränder vorhanden), aber Innenlücke wird gemeldet.
  assertEquals(r.verfuegbar, { von: "2026-07-01", bis: "2026-07-30" });
  assertEquals(r.warnungen.some((w) => w.includes("Datenlücke")), true);
});

Deno.test("aktueller Tag noch nicht da (heute fehlt) -> provisional", () => {
  const r = analysiereZeitraum("2026-07-28", "2026-07-30", ["2026-07-28", "2026-07-29"]);
  assertEquals(r.is_provisional, true);
  assertEquals(r.fehlende_tage, ["2026-07-30"]);
  assertEquals(r.latest_available_date, "2026-07-29");
});

Deno.test("Daten beginnen erst später als angefragt -> Kopf-Warnung", () => {
  const r = analysiereZeitraum("2026-06-01", "2026-06-10", tage("2026-06-05", "2026-06-10"));
  assertEquals(r.is_provisional, true);
  assertEquals(r.verfuegbar, { von: "2026-06-05", bis: "2026-06-10" });
  assertEquals(r.warnungen.some((w) => w.includes("beginnen erst")), true);
});

Deno.test("gar keine Daten -> provisional + klare Warnung, verfuegbar null", () => {
  const r = analysiereZeitraum("2026-07-01", "2026-07-05", []);
  assertEquals(r.is_provisional, true);
  assertEquals(r.verfuegbar, null);
  assertEquals(r.latest_available_date, null);
  assertEquals(r.tage_mit_daten, 0);
  assertEquals(r.fehlende_tage_anzahl, 5);
  assertEquals(r.warnungen, ["Keine Sales-&-Traffic-Daten im angefragten Zeitraum."]);
});

Deno.test("inklusive Grenzen: von und bis zählen beide", () => {
  const r = analysiereZeitraum("2026-07-01", "2026-07-03", ["2026-07-01", "2026-07-02", "2026-07-03"]);
  assertEquals(r.tage_mit_daten, 3);
  assertEquals(r.is_provisional, false);
});

Deno.test("UTC/Monatsgrenze: Monatsende korrekt gezählt (Juni hat 30 Tage)", () => {
  const r = analysiereZeitraum("2026-06-29", "2026-07-01", ["2026-06-29", "2026-06-30", "2026-07-01"]);
  assertEquals(r.tage_mit_daten, 3);
  assertEquals(r.fehlende_tage_anzahl, 0);
  assertEquals(r.is_provisional, false);
});

Deno.test("fehlende_tage-Liste gedeckelt, Anzahl bleibt vollständig", () => {
  // 100 Tage angefragt, keine Daten -> Liste ≤ 62, Anzahl = 100.
  const r = analysiereZeitraum("2026-01-01", "2026-04-10", []);
  assertEquals(r.fehlende_tage_anzahl, 100);
  assertEquals(r.fehlende_tage.length <= 62, true);
});

// --- Orders-basierter Umsatz ---

Deno.test("baueOrdersUmsatz: Gesamt + Monatsreihe + Preisabdeckung", () => {
  const r = baueOrdersUmsatz([
    { datum: "2026-07-28", umsatz_cents: 100000, einheiten: 40, zeilen: 40, zeilen_ohne_preis: 0 },
    { datum: "2026-07-29", umsatz_cents: 50000, einheiten: 20, zeilen: 22, zeilen_ohne_preis: 2 },
  ], "2026-07-01") as any;
  assertEquals(r.gesamt.umsatz, 1500); // (100000+50000)/100
  assertEquals(r.gesamt.einheiten, 60);
  assertEquals(r.gesamt.zeilen, 62);
  assertEquals(r.gesamt.zeilen_ohne_preis, 2);
  assertEquals(r.gesamt.preis_abdeckung, 96.8); // 60/62
  assertEquals(r.monatlich, [{ monat: "2026-07", umsatz: 1500, units: 60 }]);
  assertEquals(r.is_provisional, true);
  assertEquals(r.warnungen.length, 2); // Preis-Untergrenze + Pending/laufender-Tag-Hinweis
});

Deno.test("baueOrdersUmsatz: angeschnittener Startmonat wird weggelassen", () => {
  const r = baueOrdersUmsatz([
    { datum: "2026-06-20", umsatz_cents: 10000, einheiten: 5, zeilen: 5, zeilen_ohne_preis: 0 },
    { datum: "2026-07-05", umsatz_cents: 20000, einheiten: 8, zeilen: 8, zeilen_ohne_preis: 0 },
  ], "2026-06-15") as any;
  // Startmonat 2026-06 ist angeschnitten (von=...-15) -> nur Juli in der Reihe.
  assertEquals(r.monatlich, [{ monat: "2026-07", umsatz: 200, units: 8 }]);
  // Gesamt zählt trotzdem alles.
  assertEquals(r.gesamt.umsatz, 300);
});

Deno.test("baueOrdersUmsatz: alle Preise vorhanden -> keine Untergrenze-Warnung", () => {
  const r = baueOrdersUmsatz([
    { datum: "2026-07-01", umsatz_cents: 5000, einheiten: 3, zeilen: 3, zeilen_ohne_preis: 0 },
  ], "2026-07-01") as any;
  assertEquals(r.gesamt.preis_abdeckung, 100);
  assertEquals(r.warnungen.length, 1); // nur der Pending/laufender-Tag-Hinweis
});

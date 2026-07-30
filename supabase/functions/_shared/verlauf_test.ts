import { assertEquals } from "jsr:@std/assert@1";
import { analysiereZeitraum } from "./verlauf.ts";

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

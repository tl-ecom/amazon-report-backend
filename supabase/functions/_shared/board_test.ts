import { assertEquals } from "jsr:@std/assert@1";
import { baueBoardReport } from "./board.ts";

const overview = {
  status: "gelb",
  zeitraum: { von: "2026-07-01", bis: "2026-07-28" },
  is_provisional: false,
  kpis: { umsatz: 12345.67, waehrung: "EUR", sessions: 5000, unitsOrdered: 800, cvr: 16, retourenquote: 4.2 },
};
const erstattung = { summe_geschaetzt_cents: 20000, erstattet_gesamt_cents: 125517, kandidaten: [{ asin: "R1", produktname: "Erst-Produkt", geschaetzt_cents: 20000 }] };
const nachschub = { summe_laufend_cents: 100000, anzahl_leer: 1, anzahl_kritisch: 2, zeilen: [{ asin: "N1", produktname: "Leer-Produkt", status: "leer", verlust_cents: 100000 }] };
const ladenhueter = { summe_einbruch_cents: 50000, anzahl_tot: 12, anzahl_abkuehlend: 2, zeilen: [{ asin: "L1", produktname: "Kühl-Produkt", status: "abkuehlend", einbruch_cents: 50000 }] };

Deno.test("KPIs + Leaks werden übernommen, Summe stimmt", () => {
  const r = baueBoardReport(overview, erstattung, nachschub, ladenhueter) as any;
  assertEquals(r.ampel, "gelb");
  assertEquals(r.kpis.umsatz, 12345.67);
  assertEquals(r.leaks.erstattungen.offen_cents, 20000);
  assertEquals(r.leaks.nachschub.laufend_cents, 100000);
  assertEquals(r.leaks.ladenhueter.einbruch_cents, 50000);
  assertEquals(r.leaks.summe_handlungsbedarf_cents, 170000);
});

Deno.test("Prioritäten quer über Radare, größter Betrag zuerst", () => {
  const r = baueBoardReport(overview, erstattung, nachschub, ladenhueter) as any;
  assertEquals(r.prioritaeten.length, 3);
  assertEquals(r.prioritaeten[0].quelle, "nachschub"); // 100000
  assertEquals(r.prioritaeten[1].quelle, "ladenhueter"); // 50000
  assertEquals(r.prioritaeten[2].quelle, "erstattung"); // 20000
  assertEquals(r.prioritaeten[0].betrag_art, "laufend");
});

Deno.test("leere Bausteine -> Nullen, keine Prioritäten, kein Absturz", () => {
  const r = baueBoardReport(null, null, null, null) as any;
  assertEquals(r.leaks.summe_handlungsbedarf_cents, 0);
  assertEquals(r.prioritaeten.length, 0);
  assertEquals(r.ampel, null);
  assertEquals(r.kpis.waehrung, "EUR");
});

Deno.test("Ausverkauf (wiederanlauf) empfiehlt Nachschub, NICHT auslisten", () => {
  const lh = { zeilen: [{ asin: "B0FKNN9CCJ", produktname: "Obst-Etagere grün", status: "wiederanlauf", einbruch_cents: 503070 }] };
  const r = baueBoardReport(overview, { kandidaten: [] }, { zeilen: [] }, lh) as any;
  const p = r.prioritaeten[0];
  assertEquals(p.quelle, "nachschub");
  assertEquals(p.aktion.includes("Bestand sichern"), true);
  assertEquals(p.aktion.includes("auslisten"), false);
});

Deno.test("Aktion folgt dem Status: tot -> auslisten, abkuehlend -> Relaunch", () => {
  const lh = { zeilen: [
    { asin: "T", produktname: "Totes", status: "tot", einbruch_cents: 200 },
    { asin: "K", produktname: "Kuehlt", status: "abkuehlend", einbruch_cents: 100 },
  ] };
  const r = baueBoardReport(overview, { kandidaten: [] }, { zeilen: [] }, lh) as any;
  assertEquals(r.prioritaeten.find((p: any) => p.asin === "T").aktion.includes("Auslisten"), true);
  assertEquals(r.prioritaeten.find((p: any) => p.asin === "K").aktion.includes("Relaunch"), true);
});

Deno.test("Positionen ohne Betrag werden nicht als Priorität geführt", () => {
  const nur0 = { zeilen: [{ asin: "X", produktname: "P", status: "leer", verlust_cents: 0 }] };
  const r = baueBoardReport(overview, { kandidaten: [] }, nur0, { zeilen: [] }) as any;
  assertEquals(r.prioritaeten.length, 0);
});

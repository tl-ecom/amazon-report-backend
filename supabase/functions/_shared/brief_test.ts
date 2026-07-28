import { assertEquals } from "jsr:@std/assert@1";
import { fasseBriefZusammen } from "./brief.ts";

const overview = {
  status: "gelb",
  zeitraum: { von: "2026-07-20", bis: "2026-07-27" },
  is_provisional: true,
  kpis: { umsatz: 1234.5, waehrung: "EUR", sessions: 900, unitsOrdered: 42, cvr: 4.7, retourenquote: 8 },
};

Deno.test("KPIs übernehmen den echten Report-Zeitraum (nicht die Brief-Woche)", () => {
  const b = fasseBriefZusammen(overview, [], [], [], "2026-07-21T00:00:00Z") as any;
  assertEquals(b.kpis.zeitraum, { von: "2026-07-20", bis: "2026-07-27" });
  assertEquals(b.kpis.is_provisional, true);
  assertEquals(b.ampel, "gelb");
});

Deno.test("Diagnosen: nur offene zählen, nach Priorität gruppiert, Top 3", () => {
  const diag = [
    { typ: "a", asin: "B1", prioritaet: "kritisch", status: "offen", beobachtung: "x" },
    { typ: "b", asin: "B2", prioritaet: "hoch", status: "offen", beobachtung: "y" },
    { typ: "c", asin: "B3", prioritaet: "mittel", status: "offen", beobachtung: "z" },
    { typ: "d", asin: "B4", prioritaet: "niedrig", status: "offen", beobachtung: "w" },
    { typ: "e", asin: "B5", prioritaet: "kritisch", status: "behoben", beobachtung: "alt" }, // zählt nicht
  ];
  const b = fasseBriefZusammen(overview, diag, [], [], "2026-07-21T00:00:00Z") as any;
  assertEquals(b.diagnosen.offen_gesamt, 4);
  assertEquals(b.diagnosen.nach_prio, { kritisch: 1, hoch: 1, mittel: 1, niedrig: 1 });
  assertEquals(b.diagnosen.top.length, 3);
  assertEquals(b.diagnosen.top[0].prioritaet, "kritisch"); // höchste zuerst
});

Deno.test("Aufgaben: offen/in_arbeit-Zählung + in 7 Tagen erledigte", () => {
  const tasks = [
    { titel: "T1", prioritaet: "hoch", status: "offen", asin: null, erledigt_am: null },
    { titel: "T2", prioritaet: "mittel", status: "in_arbeit", asin: null, erledigt_am: null },
    { titel: "T3", prioritaet: "mittel", status: "erledigt", asin: null, erledigt_am: "2026-07-25T10:00:00Z" }, // im Fenster
    { titel: "T4", prioritaet: "mittel", status: "erledigt", asin: null, erledigt_am: "2026-07-10T10:00:00Z" }, // zu alt
  ];
  const b = fasseBriefZusammen(overview, [], tasks, [], "2026-07-21T00:00:00Z") as any;
  assertEquals(b.aufgaben.offen, 1);
  assertEquals(b.aufgaben.in_arbeit, 1);
  assertEquals(b.aufgaben.erledigt_letzte_7t, 1);
  assertEquals(b.aufgaben.top_offen.length, 2); // offen + in_arbeit
});

Deno.test("top_offen ist nach Priorität sortiert und auf 5 begrenzt", () => {
  const tasks = Array.from({ length: 7 }, (_, i) => ({
    titel: `T${i}`, prioritaet: i === 6 ? "kritisch" : "niedrig", status: "offen", asin: null, erledigt_am: null,
  }));
  const b = fasseBriefZusammen(overview, [], tasks, [], "2026-07-21T00:00:00Z") as any;
  assertEquals(b.aufgaben.top_offen.length, 5);
  assertEquals(b.aufgaben.top_offen[0].prioritaet, "kritisch");
});

Deno.test("Änderungen werden übernommen und auf 10 begrenzt", () => {
  const changes = Array.from({ length: 14 }, (_, i) => ({
    asin: `B${i}`, event_type: "preis_geaendert", previous_value: "10", new_value: "9", relevance: "hoch", effective_at: "2026-07-26",
  }));
  const b = fasseBriefZusammen(overview, [], [], changes, "2026-07-21T00:00:00Z") as any;
  assertEquals(b.aenderungen_7t.length, 10);
});

Deno.test("leere Daten kippen nicht um", () => {
  const b = fasseBriefZusammen(null, [], [], [], "2026-07-21T00:00:00Z") as any;
  assertEquals(b.diagnosen.offen_gesamt, 0);
  assertEquals(b.aufgaben.offen, 0);
  assertEquals(b.aenderungen_7t, []);
  assertEquals(b.ampel, null);
});

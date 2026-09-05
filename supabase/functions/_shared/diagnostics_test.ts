import { assertEquals } from "jsr:@std/assert@1";
import { baueDiagnosen, fingerprintOf } from "./diagnostics.ts";

// Minimale Sales/Listings-Overview-Formen für die Regel-Tests.
function sales(opts: { accCvr?: number; retourenquote?: number; units?: number; proAsin?: any[] }) {
  return {
    zeitraum: { von: "2026-07-01", bis: "2026-07-28" },
    gesamt: { cvrUnitSession: opts.accCvr ?? null, retourenquote: opts.retourenquote ?? null, unitsOrdered: opts.units ?? 0 },
    proAsin: opts.proAsin ?? [],
  };
}

Deno.test("traffic_ohne_verkauf: Traffic über Schwelle, 0 Units", () => {
  const d = baueDiagnosen(sales({ proAsin: [{ childAsin: "B01", sessions: 120, unitsOrdered: 0 }] }), null);
  const t = d.find((x) => x.typ === "traffic_ohne_verkauf");
  assertEquals(t?.asin, "B01");
  assertEquals(t?.prioritaet, "hoch");
  assertEquals(t?.konfidenz, "hoch"); // >=100 Sessions
});

Deno.test("traffic_ohne_verkauf: mittlere Konfidenz zwischen 30 und 100", () => {
  const d = baueDiagnosen(sales({ proAsin: [{ childAsin: "B01", sessions: 40, unitsOrdered: 0 }] }), null);
  assertEquals(d.find((x) => x.typ === "traffic_ohne_verkauf")?.konfidenz, "mittel");
});

Deno.test("unter Sessions-Schwelle: keine traffic_ohne_verkauf-Diagnose", () => {
  const d = baueDiagnosen(sales({ proAsin: [{ childAsin: "B01", sessions: 12, unitsOrdered: 0 }] }), null);
  assertEquals(d.some((x) => x.typ === "traffic_ohne_verkauf"), false);
});

Deno.test("conversion_unter_schnitt: unter halbem Account-CVR", () => {
  const d = baueDiagnosen(
    sales({ accCvr: 10, proAsin: [{ childAsin: "B02", sessions: 50, unitsOrdered: 2, cvrUnitSession: 4 }] }),
    null,
  );
  const c = d.find((x) => x.typ === "conversion_unter_schnitt");
  assertEquals(c?.asin, "B02");
  assertEquals(c?.prioritaet, "mittel");
});

Deno.test("gute_cvr_wenig_traffic: über Schnitt, wenig Traffic -> niedrig/gering", () => {
  const d = baueDiagnosen(
    sales({ accCvr: 5, proAsin: [{ childAsin: "B03", sessions: 10, unitsOrdered: 1, cvrUnitSession: 12 }] }),
    null,
  );
  const g = d.find((x) => x.typ === "gute_cvr_wenig_traffic");
  assertEquals(g?.prioritaet, "niedrig");
  assertEquals(g?.konfidenz, "gering");
});

Deno.test("umsatzkonzentration: Top-ASIN über 50 %", () => {
  const d = baueDiagnosen(sales({ proAsin: [{ childAsin: "B04", umsatzAnteil: 73, sessions: 5, unitsOrdered: 3 }] }), null);
  assertEquals(d.find((x) => x.typ === "umsatzkonzentration")?.asin, "B04");
});

Deno.test("hohe_retourenquote: über Schwelle bei genug Units", () => {
  const d = baueDiagnosen(sales({ retourenquote: 22, units: 80 }), null);
  const r = d.find((x) => x.typ === "hohe_retourenquote");
  assertEquals(r?.prioritaet, "hoch");
  assertEquals(r?.konfidenz, "hoch");
});

Deno.test("hohe_retourenquote: zu wenige Units -> keine Diagnose", () => {
  const d = baueDiagnosen(sales({ retourenquote: 40, units: 5 }), null);
  assertEquals(d.some((x) => x.typ === "hohe_retourenquote"), false);
});

Deno.test("fbm_ohne_bestand: ausverkaufte aktive Angebote -> kritisch", () => {
  const d = baueDiagnosen(sales({}), { data_timestamp: "2026-07-28", bestand_merchant: { ausverkauft: 3 } });
  const f = d.find((x) => x.typ === "fbm_ohne_bestand");
  assertEquals(f?.prioritaet, "kritisch");
  assertEquals(f?.konfidenz, "hoch");
});

Deno.test("Sortierung: kritisch vor hoch vor mittel", () => {
  const d = baueDiagnosen(
    sales({ accCvr: 10, retourenquote: 22, units: 80, proAsin: [{ childAsin: "B05", sessions: 120, unitsOrdered: 0 }] }),
    { data_timestamp: "2026-07-28", bestand_merchant: { ausverkauft: 1 } },
  );
  assertEquals(d[0].prioritaet, "kritisch");
});

Deno.test("fingerprintOf: stabil über Typ+ASIN, null wird zu '-'", () => {
  assertEquals(fingerprintOf({ typ: "traffic_ohne_verkauf", asin: "B01" }), "traffic_ohne_verkauf:B01");
  assertEquals(fingerprintOf({ typ: "fbm_ohne_bestand", asin: null }), "fbm_ohne_bestand:-");
});

Deno.test("leere Daten kippen nicht um", () => {
  assertEquals(baueDiagnosen(null, null), []);
});

// --- Selbstblockade (Ads) ---

import { baueAdsDiagnosen } from "./diagnostics.ts";

Deno.test("Selbstblockade: eine Diagnose je Kampagne, Paare in der Datenbasis", () => {
  const d = baueAdsDiagnosen([
    { campaign_id: "1", campaign_name: "SP Exact Etagere", ad_group_id: "a", keyword_id: "k1", keyword: "etagere obst", keyword_match: "EXACT", gebot_cents: 55, negative_id: "n1", negative: "etagere obst", negative_match: "NEGATIVE_EXACT", negative_ebene: "anzeigengruppe" },
    { campaign_id: "1", campaign_name: "SP Exact Etagere", ad_group_id: "a", keyword_id: "k2", keyword: "obstschale etagere", keyword_match: "EXACT", gebot_cents: null, negative_id: "n2", negative: "obstschale", negative_match: "NEGATIVE_PHRASE", negative_ebene: "kampagne" },
    { campaign_id: "2", campaign_name: null, ad_group_id: "b", keyword_id: "k3", keyword: "x", keyword_match: "BROAD", gebot_cents: "10", negative_id: "n3", negative: "x", negative_match: "NEGATIVE_EXACT", negative_ebene: "anzeigengruppe" },
  ], "2026-09-05T04:05:00Z");
  assertEquals(d.length, 2);
  assertEquals(d[0].typ, "ads_selbstblockade");
  assertEquals(d[0].asin, "1");
  assertEquals(d[0].beobachtung.includes("2 aktive Keywords"), true);
  assertEquals(d[0].beobachtung.includes("Kampagnenebene"), true);
  assertEquals((d[0].datenbasis as any).paare.length, 2);
  assertEquals((d[0].datenbasis as any).paare[0].gebot, 0.55);
  assertEquals((d[0].datenbasis as any).paare[1].gebot, null);
  assertEquals(d[0].prioritaet, "hoch");
  // Ohne Namen steht die ID, und die Zahl 1 wird richtig gebeugt.
  assertEquals(d[1].beobachtung.startsWith("Kampagne \u201e2\u201c: 1 aktives Keyword wird"), true);
});

Deno.test("Selbstblockade: ohne Treffer keine Diagnose", () => {
  assertEquals(baueAdsDiagnosen([], null), []);
});

import { assertEquals } from "jsr:@std/assert@1";
import { ampelStatus, baueHinweise } from "./overview.ts";

const sales = {
  gesamt: { cvrUnitSession: 8 },
  proAsin: [
    { childAsin: "B0TOP", sessions: 200, unitsOrdered: 20, cvrUnitSession: 10, umsatzAnteil: 60 },
    { childAsin: "B0TRAFFIC", sessions: 120, unitsOrdered: 0, cvrUnitSession: 0, umsatzAnteil: 0 },
    { childAsin: "B0LOWCVR", sessions: 100, unitsOrdered: 2, cvrUnitSession: 2, umsatzAnteil: 5 },
    { childAsin: "B0GEM", sessions: 10, unitsOrdered: 3, cvrUnitSession: 30, umsatzAnteil: 8 },
  ],
};

Deno.test("Hinweise: Konzentration, Traffic ohne Verkauf, CVR unter Schnitt, Gem", () => {
  const h = baueHinweise(sales, { bestand_merchant: { ausverkauft: 0 } });
  const typen = h.map((x) => x.typ);
  assertEquals(typen.includes("umsatzkonzentration"), true); // Top 60%
  assertEquals(typen.includes("traffic_ohne_verkauf"), true); // B0TRAFFIC
  assertEquals(typen.includes("conversion_unter_schnitt"), true); // B0LOWCVR 2% < 4%
  assertEquals(typen.includes("gute_cvr_wenig_traffic"), true); // B0GEM
});

Deno.test("Ampel: ausverkauftes FBM-Angebot => rot", () => {
  const h = baueHinweise(sales, { bestand_merchant: { ausverkauft: 2 } });
  assertEquals(ampelStatus(h), "rot");
});

Deno.test("Ampel: nur mittel/hoch => gelb", () => {
  const h = baueHinweise(sales, { bestand_merchant: { ausverkauft: 0 } });
  assertEquals(ampelStatus(h), "gelb");
});

Deno.test("Ampel: keine relevanten Hinweise => gruen", () => {
  const sauber = { gesamt: { cvrUnitSession: 8 }, proAsin: [{ childAsin: "B0OK", sessions: 100, unitsOrdered: 9, cvrUnitSession: 9, umsatzAnteil: 20 }] };
  assertEquals(ampelStatus(baueHinweise(sauber, { bestand_merchant: { ausverkauft: 0 } })), "gruen");
});

// --- Bewegung und Titel ---

import { baueBewegungen, kuerzeTitel } from "./overview.ts";

Deno.test("kuerzeTitel: kurz bleibt, lang wird am Wortende gekuerzt", () => {
  assertEquals(kuerzeTitel("Kratzbrett für Katzen"), "Kratzbrett für Katzen");
  const lang = "Biomülleimer Küche 5 Liter mit Deckel und Aktivkohlefilter geruchsdicht aus Edelstahl für Kompost und Bioabfall";
  const k = kuerzeTitel(lang)!;
  assertEquals(k.length <= 86, true);
  assertEquals(k.endsWith("…"), true);
  assertEquals(k.includes("  "), false);
  assertEquals(kuerzeTitel(""), null);
  assertEquals(kuerzeTitel(null), null);
});

const Z = { von: "2026-08-07", bis: "2026-09-05" };
const V = { von: "2026-07-08", bis: "2026-08-06" };

Deno.test("baueBewegungen: Gewinner/Verlierer nach Euro-Delta, Basis-Filter, Ertrag nur wenn beidseitig bekannt", () => {
  const aktuell = [
    { asin: "A", umsatz: 3000, nettogewinn: 600, nettomarge: 20 },
    { asin: "B", umsatz: 800, nettogewinn: 100, nettomarge: 12.5 },
    { asin: "C", umsatz: 40, nettogewinn: 30, nettomarge: 75 },     // +300 %, aber Rauschen
    { asin: "D", umsatz: 500, nettogewinn: null, nettomarge: null },  // ohne EK
  ];
  const vorher = [
    { asin: "A", umsatz: 2000, nettogewinn: 300, nettomarge: 15 },
    { asin: "B", umsatz: 1500, nettogewinn: 400, nettomarge: 26.7 },
    { asin: "C", umsatz: 10, nettogewinn: 5, nettomarge: 50 },
    { asin: "E", umsatz: 900, nettogewinn: 200, nettomarge: 22 },     // verschwunden
  ];
  const b = baueBewegungen(aktuell, vorher, Z, V, new Map([["A", "Produkt A mit langem Namen"]]));
  // D geht 0 -> 500 und ist Gewinner Nr. 2; C bleibt draussen (Basis).
  assertEquals(b.umsatz.gewinner.map((p) => p.asin), ["A", "D"]);
  assertEquals(b.umsatz.gewinner[0].umsatz_delta, 1000);
  assertEquals(b.umsatz.gewinner[1].umsatz_delta_prozent, null);
  assertEquals(b.umsatz.gewinner[0].umsatz_delta_prozent, 50);
  assertEquals(b.umsatz.gewinner[0].produktname, "Produkt A mit langem Namen");
  // Verlierer: E (-900) vor B (-700).
  assertEquals(b.umsatz.verlierer.map((p) => p.asin), ["E", "B"]);
  assertEquals(b.umsatz.verlierer[0].umsatz_delta_prozent, -100);
  // Ertrag: D fehlt (kein Wert), E fehlt (nur vorher), C fehlt (Basis)
  assertEquals(b.ertrag.gewinner.map((p) => p.asin), ["A"]);
  assertEquals(b.ertrag.verlierer.map((p) => p.asin), ["B"]);
  assertEquals(b.ertrag.verlierer[0].ertrag_delta, -300);
  assertEquals(b.gesamt.umsatz, 4340);
  assertEquals(b.gesamt.umsatz_delta_prozent, -1.6);
  assertEquals(b.gesamt.ertrag, 730);
  assertEquals(b.gesamt.produkte_mit_ertrag, 3);
  assertEquals(b.hinweise.some((h) => h.startsWith("1 Produkt ohne Ertragswert")), true);
});

Deno.test("baueBewegungen: Gewinner-Liste enthaelt auch neue Produkte (0 -> Umsatz)", () => {
  const b = baueBewegungen([{ asin: "N", umsatz: 400, nettogewinn: null, nettomarge: null }], [], Z, V);
  assertEquals(b.umsatz.gewinner[0].asin, "N");
  assertEquals(b.umsatz.gewinner[0].umsatz_delta_prozent, null); // 0 als Basis: kein Prozent
});

Deno.test("baueBewegungen: leer -> Hinweis statt Nullen", () => {
  const b = baueBewegungen([], [], Z, V);
  assertEquals(b.umsatz.gewinner, []);
  assertEquals(b.gesamt.ertrag, null);
  assertEquals(b.hinweise.length, 1);
});

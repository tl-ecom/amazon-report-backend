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

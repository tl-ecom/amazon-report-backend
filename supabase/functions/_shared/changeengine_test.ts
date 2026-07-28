import { assertEquals } from "jsr:@std/assert@1";
import { diffSku } from "./changeengine.ts";

const regeln = {
  preis_geaendert: { relevance_default: "niedrig", schwellen: { pct_hoch: 10, pct_mittel: 3 } },
  bestand_null: { relevance_default: "kritisch" },
  bestand_wieder_verfuegbar: { relevance_default: "hoch" },
  listing_deaktiviert: { relevance_default: "kritisch" },
  listing_aktiviert: { relevance_default: "mittel" },
  fulfillment_geaendert: { relevance_default: "mittel" },
};

const base = { price: 20, quantity: 5, status: "Active", is_fba: false };
const typen = (ks: ReturnType<typeof diffSku>) => ks.map((k) => k.event_type).sort();

Deno.test("keine Änderung → keine Events", () => {
  assertEquals(diffSku(base, { ...base }, regeln), []);
});

Deno.test("Preis -12% → preis_geaendert, relevance hoch", () => {
  const ks = diffSku(base, { ...base, price: 17.6 }, regeln);
  assertEquals(ks.length, 1);
  assertEquals(ks[0].event_type, "preis_geaendert");
  assertEquals(ks[0].relevance, "hoch");
  assertEquals(ks[0].requires_context, true);
});

Deno.test("Preis -2% → relevance niedrig, kein Kontext nötig", () => {
  const ks = diffSku(base, { ...base, price: 19.6 }, regeln);
  assertEquals(ks[0].relevance, "niedrig");
  assertEquals(ks[0].requires_context, false);
});

Deno.test("Bestand 5→0 (Merchant) → bestand_null kritisch", () => {
  const ks = diffSku(base, { ...base, quantity: 0 }, regeln);
  assertEquals(ks[0].event_type, "bestand_null");
  assertEquals(ks[0].relevance, "kritisch");
});

Deno.test("Bestand 0→3 → bestand_wieder_verfuegbar", () => {
  const ks = diffSku({ ...base, quantity: 0 }, { ...base, quantity: 3 }, regeln);
  assertEquals(ks[0].event_type, "bestand_wieder_verfuegbar");
});

Deno.test("EHRLICHKEIT: FBA-quantity null↔null → KEIN Bestand-Event", () => {
  const fba = { price: 20, quantity: null, status: "Active", is_fba: true };
  assertEquals(typen(diffSku(fba, { ...fba, quantity: null }, regeln)), []);
});

Deno.test("EHRLICHKEIT: bekannt→unbekannt (z.B. Wechsel zu FBA) erzeugt KEIN bestand_null", () => {
  const ks = diffSku(base, { ...base, quantity: null, is_fba: true }, regeln);
  // Fulfillment-Wechsel ja, Bestand-Event NEIN (curr.quantity ist unbekannt).
  assertEquals(typen(ks), ["fulfillment_geaendert"]);
});

Deno.test("Status Active→Inactive → listing_deaktiviert kritisch", () => {
  const ks = diffSku(base, { ...base, status: "Inactive" }, regeln);
  assertEquals(ks[0].event_type, "listing_deaktiviert");
  assertEquals(ks[0].relevance, "kritisch");
});

Deno.test("Mehrere Änderungen gleichzeitig werden alle erkannt", () => {
  const ks = diffSku(base, { price: 25, quantity: 0, status: "Active", is_fba: false }, regeln);
  assertEquals(typen(ks), ["bestand_null", "preis_geaendert"]);
});

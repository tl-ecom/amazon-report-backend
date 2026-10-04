// Tests für ads_negativ_wirkung.ts. Die Zahlen sind Vanejas echte Zeilen aus
// dem Lauf vom 05.10.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueNegativWirkung, type NegativZeile } from "./ads_negativ_wirkung.ts";

const NULL = { clicks: 0, spend_cents: 0, sales_cents: 0, orders: 0 };

function zeile(ueber: Partial<NegativZeile> = {}): NegativZeile {
  return {
    begriff: "kratzbretter katze", typ: "keyword", match: "exact", ebene: "gruppe",
    campaign_id: "C1", campaign_name: "SP_kw_exact_manual_kratzbrett-katze_vaneja_de", ad_group_name: "AG",
    am: "2026-09-09T15:44:00Z", quelle: "pulse_log", grund: "Misrouting zur Single-Keyword-Kampagne", tage: 22,
    vorher: { clicks: 142, spend_cents: 15031, sales_cents: 42196, orders: 25 },
    nachher: NULL,
    anderswo_vorher: { clicks: 55, spend_cents: 6294, sales_cents: 20554, orders: 13 },
    anderswo_nachher: { clicks: 86, spend_cents: 9776, sales_cents: 26844, orders: 17 },
    ...ueber,
  };
}

Deno.test("Negativ: kratzbretter katze — 25 Bestellungen abgeschnitten, 4 kamen anderswo an", () => {
  const n = baueNegativWirkung(zeile());
  assertEquals(n.einordnung, "bestellungen_abgeschnitten");
  assertEquals([n.vorher.bestellungen, n.anderswo_bestellungen_differenz, n.bestellungen_netto], [25, 4, -21]);
  assertEquals([n.kosten_gespart, n.greift_nicht], [150.31, false]);
});

Deno.test("Negativ: nur Kosten, keine Bestellung — gespart", () => {
  // "etagere obst", 09.09.: 18 Klicks, 13,54 €, keine Bestellung.
  const n = baueNegativWirkung(zeile({
    begriff: "etagere obst",
    vorher: { clicks: 18, spend_cents: 1354, sales_cents: 0, orders: 0 },
    anderswo_vorher: { clicks: 7, spend_cents: 489, sales_cents: 3359, orders: 1 }, anderswo_nachher: NULL,
  }));
  assertEquals([n.einordnung, n.kosten_gespart], ["kosten_gespart", 13.54]);
});

Deno.test("Negativ: verlagert, wenn anderswo mindestens so viel dazukommt", () => {
  const n = baueNegativWirkung(zeile({
    vorher: { clicks: 20, spend_cents: 2000, sales_cents: 6000, orders: 3 },
    anderswo_vorher: { clicks: 10, spend_cents: 800, sales_cents: 2000, orders: 1 },
    anderswo_nachher: { clicks: 30, spend_cents: 2400, sales_cents: 9000, orders: 5 },
  }));
  assertEquals([n.einordnung, n.bestellungen_netto], ["bestellungen_verlagert", 1]);
});

Deno.test("Negativ: greift nicht, wenn danach im Geltungsbereich noch Klicks kommen", () => {
  // "katzen kratzbrett", 09.09.: danach noch 10 Klicks und 3 Bestellungen.
  const n = baueNegativWirkung(zeile({
    begriff: "katzen kratzbrett",
    vorher: { clicks: 24, spend_cents: 3412, sales_cents: 8390, orders: 4 },
    nachher: { clicks: 10, spend_cents: 1490, sales_cents: 6712, orders: 3 },
    anderswo_vorher: { clicks: 82, spend_cents: 10041, sales_cents: 27936, orders: 18 },
    anderswo_nachher: { clicks: 72, spend_cents: 8870, sales_cents: 17198, orders: 10 },
  }));
  assertEquals(n.greift_nicht, true);
  // Im Bereich 4 → 3, anderswo 18 → 10: unterm Strich neun weniger.
  assertEquals([n.bestellungen_netto, n.einordnung], [-9, "bestellungen_abgeschnitten"]);
});

Deno.test("Negativ: zu früh und vorsorglich werden benannt, nicht bewertet", () => {
  const frueh = baueNegativWirkung(zeile({ tage: 6 }));
  assertEquals([frueh.einordnung, frueh.bestellungen_netto, frueh.kosten_gespart, frueh.greift_nicht], ["zu_frueh", null, null, false]);
  const vorsorglich = baueNegativWirkung(zeile({ vorher: NULL, anderswo_vorher: NULL, anderswo_nachher: NULL }));
  assertEquals(vorsorglich.einordnung, "vorsorglich");
});

Deno.test("Negativ: Phrase hat kein anderswo — weggefallene Bestellungen gelten als abgeschnitten", () => {
  const n = baueNegativWirkung(zeile({
    match: "phrase", begriff: "sisal",
    vorher: { clicks: 30, spend_cents: 2500, sales_cents: 3000, orders: 2 },
    anderswo_vorher: null, anderswo_nachher: null,
  }));
  assertEquals([n.einordnung, n.anderswo_bestellungen_differenz, n.bestellungen_netto], ["bestellungen_abgeschnitten", null, null]);
});

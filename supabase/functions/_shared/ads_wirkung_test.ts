// Tests für ads_wirkung.ts. Der erste Fall ist Vanejas "obstschale", am
// 09.09.2026 über Pulse als Exact angelegt — Zahlen aus dem Lauf vom 04.10.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueWirkung, statusAus, type WirkungZeile } from "./ads_wirkung.ts";

function zeile(ueber: Partial<WirkungZeile> = {}): WirkungZeile {
  return {
    ziel_id: "Z1", art: "keyword", text: "obstschale", match_type: "EXACT", state: "ENABLED", gebot_cents: 60,
    campaign_id: "C1", campaign_name: "CP-sp_kw_exact_manual_etagere_vaneja_de",
    angelegt: "2026-09-09T18:29:31Z", quelle: "pulse_log", tage: 17, begriff: "obstschale",
    eigen: { clicks: 114, spend_cents: 9209, sales_cents: 3359, orders: 1 },
    vorher: { clicks: 12, spend_cents: 596, sales_cents: 0, orders: 0 },
    anderswo: { clicks: 15, spend_cents: 1300, sales_cents: 0, orders: 0 },
    ...ueber,
  };
}

Deno.test("Wirkung: obstschale — eine Bestellung für 92 €, und der Begriff kostet insgesamt 99 € mehr", () => {
  const w = baueWirkung(zeile());
  assertEquals(w.status, "auswertbar");
  assertEquals([w.eigen.klicks, w.eigen.kosten, w.eigen.umsatz, w.eigen.bestellungen], [114, 92.09, 33.59, 1]);
  assertEquals(w.eigen.acos, 2.7416);
  // Der ehrliche Vergleich: neues Ziel PLUS was der Begriff anderswo weiter kostet.
  assertEquals([w.gesamt_danach!.klicks, w.gesamt_danach!.kosten], [129, 105.09]);
  assertEquals(w.kosten_differenz, 99.13);
  assertEquals(w.umsatz_differenz, 33.59);
  assertEquals(w.bestellungen_differenz, 1);
  // Kein Urteil: "mehr Umsatz als null" wäre bei 274 % ACoS eine Irreführung.
  assertEquals("urteil" in w, false);
  assertEquals(w.gebot, 0.6);
  assertEquals(w.grund, null);
  assertEquals(w.begriff_eingebrochen, false);
});

Deno.test("Wirkung: zu früh, kein Traffic, wenig Traffic — benannt statt bewertet", () => {
  assertEquals(statusAus(6, 500), "zu_frueh");
  assertEquals(statusAus(7, 0), "kein_traffic");
  assertEquals(statusAus(30, 4), "wenig_traffic");
  assertEquals(statusAus(7, 5), "auswertbar");

  const frueh = baueWirkung(zeile({ tage: 0, vorher: null, anderswo: null, eigen: { clicks: 0, spend_cents: 0, sales_cents: 0, orders: 0 } }));
  assertEquals([frueh.status, frueh.umsatz_differenz, frueh.grund?.includes("noch keine Ads-Daten")], ["zu_frueh", null, true]);

  const pausiert = baueWirkung(zeile({ state: "PAUSED", eigen: { clicks: 0, spend_cents: 0, sales_cents: 0, orders: 0 } }));
  assertEquals([pausiert.status, pausiert.grund?.includes("pausiert")], ["kein_traffic", true]);
});

Deno.test("Wirkung: ohne eindeutigen Suchbegriff kein Vorher-Vergleich", () => {
  const w = baueWirkung(zeile({ match_type: "PHRASE", begriff: null, vorher: null, anderswo: null }));
  assertEquals(w.status, "auswertbar");
  assertEquals([w.vorher, w.gesamt_danach, w.umsatz_differenz], [null, null, null]);
  assertEquals(w.grund?.includes("Phrase- oder Broad"), true);
});

Deno.test("Wirkung: hatte der Begriff davor kaum Traffic, wird er nicht verglichen", () => {
  const w = baueWirkung(zeile({ vorher: { clicks: 2, spend_cents: 90, sales_cents: 0, orders: 0 } }));
  assertEquals([w.umsatz_differenz, w.kosten_differenz], [null, null]);
  assertEquals(w.grund?.includes("erst erschlossen"), true);
});

Deno.test("Wirkung: kratzbrett l form — beim Umzug ins Exact ging der Begriff verloren", () => {
  // Vaneja, angelegt am 25.09.2026: davor 12 Klicks und 4 Bestellungen über
  // andere Ziele, seither 2 Klicks über das neue Keyword und sonst nichts.
  const w = baueWirkung(zeile({
    text: "kratzbrett l form", tage: 7, gebot_cents: 71,
    vorher: { clicks: 12, spend_cents: 1450, sales_cents: 6208, orders: 4 },
    eigen: { clicks: 2, spend_cents: 223, sales_cents: 0, orders: 0 },
    anderswo: { clicks: 0, spend_cents: 0, sales_cents: 0, orders: 0 },
  }));
  // Das Ziel selbst hat zu wenig Klicks für einen ACoS ...
  assertEquals(w.status, "wenig_traffic");
  // ... aber der Vergleich des Begriffs steht trotzdem da, und er ist der Befund.
  assertEquals([w.bestellungen_differenz, w.umsatz_differenz, w.kosten_differenz], [-4, -62.08, -12.27]);
  assertEquals(w.begriff_eingebrochen, true);
  // Und die naheliegende Ursache steht dabei: 14,50 € / 12 Klicks = 1,21 € gegen 0,71 € Gebot.
  assertEquals(w.gebot_unter_klickpreis, true);
  assertEquals(w.grund?.includes("0.71 € liegt unter dem bisherigen Klickpreis von 1.21 €"), true);
});

Deno.test("Wirkung: verlagert statt gewonnen — gleiche Bestellungen, nur anderes Ziel", () => {
  // Davor 10 Bestellungen über Broad, danach 9 über das neue Exact und 1 über Broad.
  const w = baueWirkung(zeile({
    vorher: { clicks: 100, spend_cents: 5000, sales_cents: 30000, orders: 10 },
    eigen: { clicks: 80, spend_cents: 4500, sales_cents: 27000, orders: 9 },
    anderswo: { clicks: 20, spend_cents: 500, sales_cents: 3000, orders: 1 },
  }));
  assertEquals([w.bestellungen_differenz, w.umsatz_differenz, w.kosten_differenz], [0, 0, 0]);
});

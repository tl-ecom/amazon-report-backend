// Tests für metrics.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Warum synthetische Fixtures und nicht die echten Kontodaten: Das Testkonto hat
// im Zeitraum praktisch keine Verkäufe. Bei lauter Nullen liefern die RICHTIGE
// und die FALSCHE Rechenweise dasselbe Ergebnis (0), der eigentliche Fehler wäre
// also unsichtbar. Die Fixtures unten sind so gewählt, dass beide Wege maximal
// weit auseinanderliegen.

import { assertEquals, assertAlmostEquals, assertThrows } from "jsr:@std/assert@1";
import {
  aggregiereNachAsin,
  aggregiereNachDatum,
  baueOverview,
  proAsin,
  pruefeKonsistenz,
  pruefeWaehrung,
  safeDiv,
  toCents,
} from "./metrics.ts";

const EUR = (amount: number) => ({ amount, currencyCode: "EUR" });

function tag(date: string, sessions: number, unitsOrdered: number, umsatz: number, extra: Record<string, any> = {}) {
  return {
    date,
    salesByDate: {
      unitsOrdered,
      totalOrderItems: unitsOrdered,
      unitsShipped: unitsOrdered,
      ordersShipped: unitsOrdered,
      unitsRefunded: 0,
      orderedProductSales: EUR(umsatz),
      shippedProductSales: EUR(umsatz),
      ...(extra.sales ?? {}),
    },
    trafficByDate: {
      sessions,
      pageViews: sessions,
      // Amazons fertige Prozentspalte — darf NIE aufsummiert werden:
      unitSessionPercentage: sessions ? (unitsOrdered / sessions) * 100 : 0,
      orderItemSessionPercentage: sessions ? (unitsOrdered / sessions) * 100 : 0,
      buyBoxPercentage: 100,
      ...(extra.traffic ?? {}),
    },
  };
}

function asin(childAsin: string, sessions: number, unitsOrdered: number, umsatz: number, parentAsin = "P1") {
  return {
    childAsin,
    parentAsin,
    salesByAsin: {
      unitsOrdered,
      totalOrderItems: unitsOrdered,
      unitsShipped: unitsOrdered,
      ordersShipped: unitsOrdered,
      unitsRefunded: 0,
      orderedProductSales: EUR(umsatz),
      shippedProductSales: EUR(umsatz),
    },
    trafficByAsin: {
      sessions,
      pageViews: sessions,
      sessionPercentage: 25,
      unitSessionPercentage: sessions ? (unitsOrdered / sessions) * 100 : 0,
    },
  };
}

// --- DER Kern-Test: der Grund, warum dieses Modul überhaupt existiert ---
Deno.test("CVR wird aus Rohwerten gerechnet, nicht aus Amazons Prozentspalten", () => {
  // Tag A: 10 von 100 Sessions kaufen  → Amazon meldet 10 %
  // Tag B:  1 von   1 Session  kauft   → Amazon meldet 100 %
  const payload = { salesAndTrafficByDate: [tag("2026-07-01", 100, 10, 100), tag("2026-07-02", 1, 1, 10)] };

  const k = aggregiereNachDatum(payload);

  assertEquals(k.sessions, 101);
  assertEquals(k.unitsOrdered, 11);

  // RICHTIG: 11 / 101 = 10,89 %
  assertAlmostEquals(k.cvrUnitSession!, 10.89, 0.01);

  // Die falschen Wege zum Vergleich — beide weit daneben:
  const summeDerProzente = 10 + 100;          // 110 %  (absurd)
  const mittelDerProzente = (10 + 100) / 2;   //  55 %  (überbewertet den Ein-Session-Tag)
  assertEquals(k.cvrUnitSession === summeDerProzente, false);
  assertEquals(k.cvrUnitSession === mittelDerProzente, false);
});

Deno.test("Durchschnittspreis = Gesamtumsatz / Gesamtmenge, nicht Mittel der Tagesdurchschnitte", () => {
  // Tag A: 10 Stück für 100 € (Ø 10 €), Tag B: 1 Stück für 50 € (Ø 50 €)
  const payload = { salesAndTrafficByDate: [tag("2026-07-01", 100, 10, 100), tag("2026-07-02", 10, 1, 50)] };
  const k = aggregiereNachDatum(payload);

  // RICHTIG: 150 € / 11 Stück = 13,64 €
  assertAlmostEquals(k.durchschnittspreis!, 13.64, 0.01);
  // Mittel der Tagesdurchschnitte wäre (10+50)/2 = 30 € — deutlich falsch.
  assertEquals(k.durchschnittspreis === 30, false);
});

// --- Division durch Null: "keine Aussage" ist nicht "null Prozent" ---
Deno.test("Nenner 0 ergibt null, nicht 0 / NaN / Infinity", () => {
  const payload = { salesAndTrafficByDate: [tag("2026-07-10", 0, 0, 0)] };
  const k = aggregiereNachDatum(payload);

  assertEquals(k.sessions, 0);
  assertEquals(k.cvrUnitSession, null);
  assertEquals(k.durchschnittspreis, null);
  assertEquals(k.pageViewsProSession, null);
  assertEquals(k.retourenquote, null);
});

Deno.test("safeDiv liefert null statt Infinity", () => {
  assertEquals(safeDiv(5, 0), null);
  assertEquals(safeDiv(0, 0), null);
  assertEquals(safeDiv(10, 4), 2.5);
});

// --- Geld: Fließkomma-Drift ---
Deno.test("Geldbetraege driften beim Summieren nicht", () => {
  // 0.1 + 0.2 ergibt in Fließkomma 0.30000000000000004
  const payload = {
    salesAndTrafficByDate: [tag("2026-07-01", 1, 1, 0.1), tag("2026-07-02", 1, 1, 0.2)],
  };
  const k = aggregiereNachDatum(payload);
  assertEquals(k.umsatzOrdered, 0.3);
});

Deno.test("toCents rundet korrekt", () => {
  assertEquals(toCents({ amount: 7.85, currencyCode: "EUR" }), 785);
  assertEquals(toCents({ amount: 0, currencyCode: "EUR" }), 0);
  assertEquals(toCents(null), 0);
});

Deno.test("viele kleine Betraege summieren sich exakt", () => {
  const tage = Array.from({ length: 100 }, (_, i) => tag(`2026-07-${i}`, 1, 1, 0.07));
  const k = aggregiereNachDatum({ salesAndTrafficByDate: tage });
  assertEquals(k.umsatzOrdered, 7); // 100 × 0.07 — naiv summiert: 7.000000000000001
});

// --- Währung ---
Deno.test("gemischte Waehrungen werden abgelehnt statt stumm addiert", () => {
  const payload = {
    salesAndTrafficByDate: [
      tag("2026-07-01", 1, 1, 10),
      {
        date: "2026-07-02",
        salesByDate: { unitsOrdered: 1, orderedProductSales: { amount: 10, currencyCode: "USD" } },
        trafficByDate: { sessions: 1 },
      },
    ],
  };
  assertThrows(() => pruefeWaehrung(payload), Error, "Uneinheitliche Währungen");
});

Deno.test("einheitliche Waehrung wird durchgereicht", () => {
  const payload = { salesAndTrafficByDate: [tag("2026-07-01", 1, 1, 10)] };
  assertEquals(pruefeWaehrung(payload), "EUR");
  assertEquals(aggregiereNachDatum(payload).waehrung, "EUR");
});

// --- Konsistenz zwischen den Granularitaeten ---
Deno.test("Konsistenzpruefung erkennt Divergenz zwischen byDate und byAsin", () => {
  // Genau der reale Fall vom 2026-07-17: byAsin sieht eine Bestellung, die
  // byDate noch nicht hat (volatiles Fenster).
  const payload = {
    salesAndTrafficByDate: [tag("2026-07-01", 40, 0, 0)],
    salesAndTrafficByAsin: [asin("B0DNT2FDN9", 40, 1, 7.85)],
  };
  const k = pruefeKonsistenz(aggregiereNachDatum(payload), aggregiereNachAsin(payload));
  assertEquals(k.ok, false);
  assertEquals(k.abweichungen.length, 2); // unitsOrdered und umsatzOrdered
});

Deno.test("Konsistenzpruefung ist ok, wenn beide Granularitaeten uebereinstimmen", () => {
  const payload = {
    salesAndTrafficByDate: [tag("2026-07-01", 40, 1, 8.05)],
    salesAndTrafficByAsin: [asin("B0DNT2FDN9", 40, 1, 8.05)],
  };
  const k = pruefeKonsistenz(aggregiereNachDatum(payload), aggregiereNachAsin(payload));
  assertEquals(k.ok, true);
  assertEquals(k.abweichungen, []);
});

// --- Pro-ASIN ---
Deno.test("proAsin sortiert nach Umsatz und rechnet den Anteil", () => {
  const payload = {
    salesAndTrafficByAsin: [
      asin("KLEIN", 10, 1, 25),
      asin("GROSS", 5, 3, 75),
      asin("NULL", 8, 0, 0),
    ],
  };
  const liste = proAsin(payload);

  assertEquals(liste.map((a) => a.childAsin), ["GROSS", "KLEIN", "NULL"]);
  assertEquals(liste[0].umsatzAnteil, 75);
  assertEquals(liste[1].umsatzAnteil, 25);
  assertEquals(liste[2].umsatzAnteil, 0);
  // ASIN ohne Verkauf, aber mit Traffic: CVR 0 %, kein Durchschnittspreis.
  assertEquals(liste[2].cvrUnitSession, 0);
  assertEquals(liste[2].durchschnittspreis, null);
});

Deno.test("umsatzAnteil ist null, wenn gar kein Umsatz da ist", () => {
  const payload = { salesAndTrafficByAsin: [asin("A", 5, 0, 0), asin("B", 3, 0, 0)] };
  const liste = proAsin(payload);
  assertEquals(liste[0].umsatzAnteil, null); // 0/0 → keine Aussage, nicht 0 %
});

// --- Robustheit gegen unvollstaendige Daten ---
Deno.test("leerer Payload kippt nicht um", () => {
  const o = baueOverview({}, "2026-07-17T00:00:00Z", false);
  assertEquals(o.gesamt.sessions, 0);
  assertEquals(o.gesamt.cvrUnitSession, null);
  assertEquals(o.zeitraum.tage, 0);
  assertEquals(o.proAsin, []);
});

Deno.test("fehlende Felder zaehlen als 0, nicht als NaN", () => {
  const payload = {
    salesAndTrafficByDate: [{ date: "2026-07-01", salesByDate: {}, trafficByDate: { sessions: 5 } }],
  };
  const k = aggregiereNachDatum(payload);
  assertEquals(k.unitsOrdered, 0);
  assertEquals(k.umsatzOrdered, 0);
  assertEquals(k.sessions, 5);
  assertEquals(k.cvrUnitSession, 0);
});

// --- Gesamtausgabe ---
Deno.test("baueOverview liefert Zeitraum, Herkunft und Formeln mit", () => {
  const payload = {
    salesAndTrafficByDate: [tag("2026-06-15", 20, 1, 8.05), tag("2026-07-15", 39, 0, 0)],
    salesAndTrafficByAsin: [asin("B0DNT2FDN9", 59, 1, 8.05)],
  };
  const o = baueOverview(payload, "2026-07-17T08:14:42.866Z", false);

  assertEquals(o.zeitraum, { von: "2026-06-15", bis: "2026-07-15", tage: 2 });
  assertEquals(o.data_timestamp, "2026-07-17T08:14:42.866Z");
  assertEquals(o.is_provisional, false);
  assertEquals(o.gesamt.sessions, 59);
  assertEquals(o.gesamt.umsatzOrdered, 8.05);
  assertEquals(o.konsistenz.ok, true);
  // Die Formeln gehen mit raus, damit nachvollziehbar ist, wie gerechnet wurde.
  assertEquals(typeof o.formeln.cvrUnitSession, "string");
});

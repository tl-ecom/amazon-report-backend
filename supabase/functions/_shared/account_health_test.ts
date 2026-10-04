// Tests für account_health.ts. Die Nutzlast ist ein Ausschnitt aus Vanejas
// echter Antwort vom 04.10.2026 — gekürzt, Werte unverändert.

import { assertEquals } from "jsr:@std/assert@1";
import { baueAccountHealth, zielVerfehlt } from "./account_health.ts";

const ZEIT = { reportingDateTo: "2026-09-24T23:59:59Z", reportingDateFrom: "2026-08-26T00:00:00Z" };

const ECHT = {
  accountStatuses: [{ status: "NORMAL", marketplaceId: "A1PA6795UKMFR9" }],
  performanceMetrics: [{
    marketplaceId: "A1PA6795UKMFR9",
    warningStates: [],
    orderDefectRate: {
      afn: { rate: 0, status: "GOOD", orderCount: 4322, targetValue: 0.01, targetCondition: "LESS_THAN", reportingDateRange: ZEIT },
      mfn: { rate: 0, status: "GOOD", orderCount: 11, targetValue: 0.01, targetCondition: "LESS_THAN", reportingDateRange: ZEIT },
    },
    onTimeDeliveryRate: {
      rate: 0.42857142857142855, status: "GOOD", targetValue: 0.97, targetCondition: "GREATER_THAN",
      reportingDateRange: ZEIT, onTimeDeliveryCount: 3, shipmentCountWithValidTracking: 7,
    },
    validTrackingRate: { rate: 1, status: "GOOD", targetValue: 0.95, shipmentCount: 7, targetCondition: "GREATER_THAN", reportingDateRange: ZEIT },
    listingPolicyViolations: { status: "GOOD", targetValue: 0, defectsCount: 0, targetCondition: "EQUALS", reportingDateRange: ZEIT },
    accountHealthRating: { ahrScore: 428, ahrStatus: "GREAT", reportingDateRange: ZEIT },
    lateShipmentRateList: [{ rate: 0, status: "GOOD", targetValue: 0.04, targetCondition: "LESS_THAN" }],
    policyViolationWarnings: { warningsCount: 0, reportingDateRange: ZEIT },
  }],
};

Deno.test("Account Health: Rating, Kontostatus und Kennzahlen aus der echten Antwort", () => {
  const m = (baueAccountHealth(ECHT, "2026-10-04T16:31:00Z") as any).marktplaetze[0];
  assertEquals(m.konto_status, "NORMAL");
  assertEquals(m.rating, { punkte: 428, status: "GREAT" });
  assertEquals(m.verwarnungen, 0);
  // orderDefectRate kommt je Versandart; die Liste und das Rating sind keine Kennzahlen.
  assertEquals(m.kennzahlen.map((k: any) => k.kennzahl), [
    "listingPolicyViolations", "onTimeDeliveryRate", "orderDefectRate.afn", "orderDefectRate.mfn", "validTrackingRate",
  ]);
  assertEquals(m.handlungsbedarf, []);
});

Deno.test("Account Health: 43 % pünktlich bei Ziel 97 % — Amazon sagt GOOD, die Zahl steht trotzdem da", () => {
  const m = (baueAccountHealth(ECHT, null) as any).marktplaetze[0];
  assertEquals(m.ziel_verfehlt_trotz_gutem_status.map((k: any) => k.kennzahl), ["onTimeDeliveryRate"]);
  // Kein Handlungsbedarf: über das Konto entscheidet Amazons Status, nicht unsere Rechnung.
  assertEquals(m.handlungsbedarf.length, 0);
});

Deno.test("Account Health: ein Status jenseits von GOOD ist Handlungsbedarf", () => {
  const p = structuredClone(ECHT);
  p.performanceMetrics[0].listingPolicyViolations = { ...p.performanceMetrics[0].listingPolicyViolations, status: "AT_RISK", defectsCount: 2 };
  const m = (baueAccountHealth(p, null) as any).marktplaetze[0];
  assertEquals(m.handlungsbedarf.map((k: any) => [k.kennzahl, k.anzahl, k.ziel_verfehlt]), [["listingPolicyViolations", 2, true]]);
});

Deno.test("zielVerfehlt: drei Bedingungen, und ohne Wert keine Aussage", () => {
  assertEquals(zielVerfehlt(0.005, 0.01, "LESS_THAN"), false);
  assertEquals(zielVerfehlt(0.01, 0.01, "LESS_THAN"), true);
  assertEquals(zielVerfehlt(0.98, 0.97, "GREATER_THAN"), false);
  assertEquals(zielVerfehlt(0, 0, "EQUALS"), false);
  assertEquals(zielVerfehlt(null, 0.01, "LESS_THAN"), null);
  assertEquals(zielVerfehlt(1, 0, "ETWAS_NEUES"), null);
});

Deno.test("Account Health: leere Antwort gibt eine leere Liste, keinen Absturz", () => {
  assertEquals((baueAccountHealth({}, null) as any).marktplaetze, []);
});

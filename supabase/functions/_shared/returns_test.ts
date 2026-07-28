// Tests für returns.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Fixtures aus der ECHTEN Kopfzeile (35 Spalten) abgeleitet; Werte synthetisch,
// da der echte Report leer war. Die Tests prüfen die formatsichere Logik.

import { assertEquals } from "jsr:@std/assert@1";
import { baueReturnsOverview } from "./returns.ts";

function retoure(o: {
  asin?: string;
  sku?: string;
  name?: string;
  qty?: string;
  reason?: string;
  resolution?: string;
  status?: string;
  refunded?: string;
  currency?: string;
  date?: string;
}): Record<string, string> {
  return {
    "ASIN": o.asin ?? "B001",
    "Merchant SKU": o.sku ?? "SKU-1",
    "Item Name": o.name ?? "Artikel",
    "Return quantity": o.qty ?? "1",
    "Return Reason": o.reason ?? "",
    "Resolution": o.resolution ?? "",
    "Return request status": o.status ?? "",
    "Refunded Amount": o.refunded ?? "",
    "Currency code": o.currency ?? "",
    "Return request date": o.date ?? "2026-07-10",
  };
}

const ts = "2026-07-17T00:00:00Z";
const payload = (rows: Record<string, string>[]) => ({ format: "tsv", rows });

// --- leerer Report (der reale Fall) ---
Deno.test("leerer Report ist sauber und als unvalidiert markiert", () => {
  const o = baueReturnsOverview(payload([]), ts);
  assertEquals(o.gesamt.retouren, 0);
  assertEquals(o.gesamt.einheiten, 0);
  assertEquals(o.gesamt.erstattet_bekannt, null);
  assertEquals(o.unvalidiert, true);
  assertEquals(typeof o.warnungen.find((w) => w.includes("Keine Retouren")), "string");
});

// --- Zählen und Einheiten ---
Deno.test("Retouren und Einheiten werden gezaehlt", () => {
  const o = baueReturnsOverview(
    payload([retoure({ qty: "2" }), retoure({ qty: "1" }), retoure({ qty: "3" })]),
    ts
  );
  assertEquals(o.gesamt.retouren, 3);
  assertEquals(o.gesamt.einheiten, 6);
});

// --- Gruppierung nach Grund (formatsicher) ---
Deno.test("Gruppierung nach Return Reason", () => {
  const o = baueReturnsOverview(
    payload([
      retoure({ reason: "Defekt", qty: "1" }),
      retoure({ reason: "Defekt", qty: "2" }),
      retoure({ reason: "Zu klein", qty: "1" }),
    ]),
    ts
  );
  assertEquals(o.nach_grund[0], { grund: "Defekt", retouren: 2, einheiten: 3 });
  assertEquals(o.nach_grund[1], { grund: "Zu klein", retouren: 1, einheiten: 1 });
});

Deno.test("leerer Grund wird als '(ohne Angabe)' gefuehrt", () => {
  const o = baueReturnsOverview(payload([retoure({ reason: "" })]), ts);
  assertEquals(o.nach_grund[0].grund, "(ohne Angabe)");
});

// --- Beträge: tolerant, null statt 0 bei unlesbar ---
Deno.test("Refunded Amount wird tolerant summiert", () => {
  const o = baueReturnsOverview(
    payload([
      retoure({ refunded: "7.85", currency: "EUR" }),
      retoure({ refunded: "18.04", currency: "EUR" }),
    ]),
    ts
  );
  assertEquals(o.gesamt.erstattet_bekannt, 25.89);
  assertEquals(o.gesamt.waehrung, "EUR");
  assertEquals(o.gesamt.zeilen_ohne_betrag, 0);
});

Deno.test("Betrag mit Komma-Dezimaltrenner wird verstanden", () => {
  const o = baueReturnsOverview(payload([retoure({ refunded: "12,50", currency: "EUR" })]), ts);
  assertEquals(o.gesamt.erstattet_bekannt, 12.5);
});

Deno.test("Betrag mit Waehrungssymbol wird tolerant geparst", () => {
  const o = baueReturnsOverview(payload([retoure({ refunded: "EUR 9.99", currency: "EUR" })]), ts);
  assertEquals(o.gesamt.erstattet_bekannt, 9.99);
});

Deno.test("fehlende Betraege zaehlen als unbekannt, nicht als 0", () => {
  const o = baueReturnsOverview(
    payload([retoure({ refunded: "10.00", currency: "EUR" }), retoure({ refunded: "" })]),
    ts
  );
  assertEquals(o.gesamt.erstattet_bekannt, 10); // nur der bekannte
  assertEquals(o.gesamt.zeilen_ohne_betrag, 1);
});

Deno.test("wenn KEINE Zeile einen Betrag hat, ist erstattet_bekannt null", () => {
  const o = baueReturnsOverview(payload([retoure({ refunded: "" }), retoure({ refunded: "" })]), ts);
  assertEquals(o.gesamt.erstattet_bekannt, null);
  assertEquals(o.gesamt.zeilen_ohne_betrag, 2);
});

// --- Geld-Drift ---
Deno.test("Betraege driften nicht", () => {
  const o = baueReturnsOverview(
    payload([retoure({ refunded: "0.10", currency: "EUR" }), retoure({ refunded: "0.20", currency: "EUR" })]),
    ts
  );
  assertEquals(o.gesamt.erstattet_bekannt, 0.3);
});

// --- Währung ---
Deno.test("gemischte Waehrungen werden gewarnt, Summe als bedeutungslos markiert", () => {
  const o = baueReturnsOverview(
    payload([retoure({ refunded: "10", currency: "EUR" }), retoure({ refunded: "10", currency: "GBP" })]),
    ts
  );
  assertEquals(o.gesamt.waehrung, null); // nicht eindeutig
  assertEquals(typeof o.warnungen.find((w) => w.includes("Mehrere Währungen")), "string");
});

// --- nach ASIN ---
Deno.test("Retouren nach ASIN, sortiert nach Einheiten", () => {
  const o = baueReturnsOverview(
    payload([
      retoure({ asin: "B0KLEIN", qty: "1" }),
      retoure({ asin: "B0GROSS", qty: "5" }),
      retoure({ asin: "B0GROSS", qty: "2" }),
    ]),
    ts
  );
  assertEquals(o.nach_asin[0].asin, "B0GROSS");
  assertEquals(o.nach_asin[0].retouren, 2);
  assertEquals(o.nach_asin[0].einheiten, 7);
  assertEquals(o.nach_asin[1].asin, "B0KLEIN");
});

// --- Zeitraum aus den Antragsdaten (als String, kein Parsing) ---
Deno.test("Zeitraum kommt als String-Min/Max der Antragsdaten", () => {
  const o = baueReturnsOverview(
    payload([retoure({ date: "2026-07-10" }), retoure({ date: "2026-07-03" }), retoure({ date: "2026-07-15" })]),
    ts
  );
  assertEquals(o.zeitraum, { von: "2026-07-03", bis: "2026-07-15" });
});

// --- unvalidiert-Kennzeichnung bleibt immer ---
Deno.test("auch mit Daten bleibt unvalidiert=true bis zur echten Verifikation", () => {
  const o = baueReturnsOverview(payload([retoure({ reason: "Defekt" })]), ts);
  assertEquals(o.unvalidiert, true);
  assertEquals(typeof o.warnungen.find((w) => w.includes("noch nicht validiert")), "string");
});

Deno.test("payload ohne rows kippt nicht um", () => {
  const o = baueReturnsOverview({}, ts);
  assertEquals(o.gesamt.retouren, 0);
});

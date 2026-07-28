// Tests für orders.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { baueOrdersOverview, parseMenge, parsePreisCents, pruefeWaehrung } from "./orders.ts";

/** Baut eine Orders-Zeile. Preis "" = kein Preis (wie bei MCF). */
function pos(o: {
  id: string;
  asin?: string;
  menge?: string;
  preis?: string;
  kanal?: string;
  status?: string;
  datum?: string;
  waehrung?: string;
}): Record<string, string> {
  return {
    "amazon-order-id": o.id,
    asin: o.asin ?? "B000000001",
    quantity: o.menge ?? "1",
    "item-price": o.preis ?? "",
    currency: o.waehrung ?? (o.preis ? "EUR" : ""),
    "sales-channel": o.kanal ?? "Amazon.de",
    "order-status": o.status ?? "Shipped",
    "purchase-date": o.datum ?? "2026-07-01T10:00:00+00:00",
  };
}

const payload = (rows: Record<string, string>[]) => ({ format: "tsv", rows, rowCount: rows.length });

// --- Preisfelder: leer heißt unbekannt, nicht null Euro ---
Deno.test("leerer Preis ergibt null, nicht 0", () => {
  assertEquals(parsePreisCents(""), null);
  assertEquals(parsePreisCents("   "), null);
  assertEquals(parsePreisCents(undefined), null);
  assertEquals(parsePreisCents(null), null);
  // Eine echte Null ist etwas anderes als "kein Wert":
  assertEquals(parsePreisCents("0"), 0);
  assertEquals(parsePreisCents("0.00"), 0);
});

Deno.test("Preise werden in Cent umgerechnet", () => {
  assertEquals(parsePreisCents("7.85"), 785);
  assertEquals(parsePreisCents("18.04"), 1804);
  assertEquals(parsePreisCents("unsinn"), null);
});

Deno.test("Mengen werden gelesen", () => {
  assertEquals(parseMenge("3"), 3);
  assertEquals(parseMenge(""), 0);
  assertEquals(parseMenge("0"), 0);
  assertEquals(parseMenge("quatsch"), 0);
});

// --- DER Kern: Positionen sind keine Bestellungen ---
Deno.test("mehrere Positionen derselben Bestellung zaehlen als EINE Bestellung", () => {
  // Eine Bestellung mit drei SKUs = 3 Zeilen, aber 1 Bestellung.
  const o = baueOrdersOverview(
    payload([
      pos({ id: "028-1", asin: "A1", preis: "10.00" }),
      pos({ id: "028-1", asin: "A2", preis: "20.00" }),
      pos({ id: "028-1", asin: "A3", preis: "5.00" }),
      pos({ id: "028-2", asin: "A1", preis: "10.00" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  assertEquals(o.gesamt.positionen, 4);
  assertEquals(o.gesamt.bestellungen, 2); // NICHT 4
  assertEquals(o.gesamt.umsatz, 45);
});

// --- DER zweite Kern: leerer Preis ist unbekannt ---
Deno.test("Positionen ohne Preis werden nicht als 0 Euro mitgezaehlt", () => {
  // Genau der reale MCF-Fall: Non-Amazon liefert keinen Preis.
  const o = baueOrdersOverview(
    payload([
      pos({ id: "028-1", preis: "18.04", kanal: "Amazon.com.be" }),
      pos({ id: "S02-1", preis: "", menge: "3", kanal: "Non-Amazon" }),
      pos({ id: "S02-2", preis: "", menge: "8", kanal: "Non-Amazon" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  assertEquals(o.gesamt.umsatz, 18.04);
  assertEquals(o.gesamt.positionenOhnePreis, 2);
  assertEquals(o.gesamt.einheitenOhnePreis, 11);
  assertEquals(o.gesamt.umsatzVollstaendig, false);
  // Die Einheiten zählen trotzdem mit — nur der Umsatz ist unbekannt.
  assertEquals(o.gesamt.einheiten, 12);

  const warnung = o.warnungen.find((w) => w.includes("KEINEN Preis"));
  assertEquals(typeof warnung, "string");
  assertEquals(warnung!.includes("Non-Amazon"), true);
});

// --- DER dritte Kern: item-price-Semantik ---
Deno.test("solange alle bepreisten Zeilen quantity 1 haben, ist der Umsatz eindeutig", () => {
  // Das ist der heutige Zustand des Testkontos.
  const o = baueOrdersOverview(
    payload([
      pos({ id: "028-1", preis: "7.85", menge: "1" }),
      pos({ id: "028-2", preis: "18.04", menge: "1" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  assertEquals(o.gesamt.umsatzEindeutig, true);
  assertEquals(o.gesamt.umsatz, 25.89);
  // Beide Lesarten liefern dasselbe — deshalb ist die Zahl gefahrlos.
  assertEquals(o.gesamt.umsatzAlsZeilensumme, 25.89);
  assertEquals(o.gesamt.umsatzAlsStueckpreisMalMenge, 25.89);
  assertEquals(o.warnungen.find((w) => w.includes("item-price-Semantik")), undefined);
});

Deno.test("bepreiste Zeile mit quantity>1 macht den Umsatz mehrdeutig — dann KEINE Zahl", () => {
  // Dieser Fall existiert am Testkonto noch nicht. Sobald er eintritt,
  // beantwortet er die offene Frage — und bis dahin darf keine Zahl behauptet werden.
  const o = baueOrdersOverview(
    payload([
      pos({ id: "028-1", preis: "10.00", menge: "1" }),
      pos({ id: "028-2", preis: "20.00", menge: "3" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  assertEquals(o.gesamt.umsatzEindeutig, false);
  assertEquals(o.gesamt.umsatz, null); // <- keine der beiden Lesarten wird behauptet
  assertEquals(o.gesamt.umsatzAlsZeilensumme, 30); // 10 + 20
  assertEquals(o.gesamt.umsatzAlsStueckpreisMalMenge, 70); // 10×1 + 20×3

  const w = o.warnungen.find((x) => x.includes("item-price-Semantik"));
  assertEquals(typeof w, "string");
  assertEquals(w!.includes("30"), true);
  assertEquals(w!.includes("70"), true);
});

// --- "nichts verkauft" ist nicht "Preis unbekannt" ---
Deno.test("Kanal ohne jeden Preis meldet null, NICHT 0 Euro", () => {
  // Realer Fall: der Kanal "Non-Amazon" (MCF) hat Bestellungen, aber keine
  // Preise. "umsatz: 0" würde behaupten, dort sei nichts umgesetzt worden.
  const o = baueOrdersOverview(
    payload([
      pos({ id: "S02-1", preis: "", menge: "3", kanal: "Non-Amazon" }),
      pos({ id: "S02-2", preis: "", menge: "8", kanal: "Non-Amazon" }),
      pos({ id: "028-1", preis: "7.85", kanal: "Amazon.de" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  const mcf = o.proKanal.find((k) => k.kanal === "Non-Amazon")!;
  assertEquals(mcf.positionen, 2);
  assertEquals(mcf.einheiten, 11);
  assertEquals(mcf.umsatz, null); // NICHT 0
  assertEquals(mcf.umsatzAlsZeilensumme, null);
  assertEquals(mcf.umsatzAlsStueckpreisMalMenge, null);
  assertEquals(mcf.umsatzVollstaendig, false);

  // Der Kanal mit Preis bleibt davon unberührt.
  const de = o.proKanal.find((k) => k.kanal === "Amazon.de")!;
  assertEquals(de.umsatz, 7.85);
});

Deno.test("ASIN ohne jeden Preis meldet ebenfalls null", () => {
  const o = baueOrdersOverview(
    payload([pos({ id: "S02-1", asin: "B0DW43MJC9", preis: "", menge: "8", kanal: "Non-Amazon" })]),
    "2026-07-17T00:00:00Z",
    false
  );
  const a = o.proAsin.find((x) => x.asin === "B0DW43MJC9")!;
  assertEquals(a.einheiten, 8);
  assertEquals(a.umsatz, null);
});

Deno.test("teilweise bekannte Preise ergeben eine Untergrenze, nicht null", () => {
  // Wenn WENIGSTENS eine Position einen Preis hat, ist die Summe eine echte
  // (wenn auch unvollständige) Aussage — dann null zu melden wäre zu pessimistisch.
  const o = baueOrdersOverview(
    payload([
      pos({ id: "1", preis: "10.00", kanal: "Gemischt" }),
      pos({ id: "2", preis: "", kanal: "Gemischt" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );
  const k = o.proKanal[0];
  assertEquals(k.umsatz, 10);
  assertEquals(k.umsatzVollstaendig, false);
});

Deno.test("Report ganz ohne Bestellungen meldet 0, nicht null", () => {
  // Hier ist 0 die richtige Aussage: es wurde tatsächlich nichts verkauft.
  const o = baueOrdersOverview(payload([]), "2026-07-17T00:00:00Z", false);
  assertEquals(o.gesamt.positionen, 0);
  assertEquals(o.gesamt.umsatz, 0);
});

// --- Kanaele ---
Deno.test("nach Kanal aufgeschluesselt, mit Warnung gegen den Vergleich mit Sales & Traffic", () => {
  const o = baueOrdersOverview(
    payload([
      pos({ id: "028-1", preis: "7.85", kanal: "Amazon.de" }),
      pos({ id: "408-1", preis: "18.04", kanal: "Amazon.com.be" }),
      pos({ id: "S02-1", preis: "", kanal: "Non-Amazon" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  assertEquals(o.proKanal.length, 3);
  assertEquals(o.proKanal.map((k) => k.kanal).sort(), ["Amazon.com.be", "Amazon.de", "Non-Amazon"]);
  const de = o.proKanal.find((k) => k.kanal === "Amazon.de")!;
  assertEquals(de.umsatz, 7.85);
  assertEquals(de.bestellungen, 1);

  const w = o.warnungen.find((x) => x.includes("Vertriebskanäle"));
  assertEquals(typeof w, "string");
  assertEquals(w!.includes("get-sales-overview"), true);
});

// --- Status ---
Deno.test("Pending wird als volatil gewarnt", () => {
  const o = baueOrdersOverview(
    payload([
      pos({ id: "028-1", preis: "7.85", status: "Pending" }),
      pos({ id: "028-2", preis: "18.04", status: "Shipped" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );
  assertEquals(o.proStatus.map((s) => s.status).sort(), ["Pending", "Shipped"]);
  assertEquals(typeof o.warnungen.find((w) => w.includes("Pending")), "string");
});

// --- Waehrung ---
Deno.test("gemischte Waehrungen werden abgelehnt", () => {
  const rows = [
    pos({ id: "1", preis: "10", waehrung: "EUR" }),
    pos({ id: "2", preis: "10", waehrung: "GBP" }),
  ];
  assertThrows(() => pruefeWaehrung(rows), Error, "Uneinheitliche Währungen");
});

Deno.test("fehlende Waehrung bei preislosen Zeilen stoert nicht", () => {
  // MCF-Zeilen haben weder Preis noch Währung — das ist kein Währungskonflikt.
  const rows = [pos({ id: "1", preis: "10", waehrung: "EUR" }), pos({ id: "2", preis: "" })];
  pruefeWaehrung(rows); // darf nicht werfen
  const o = baueOrdersOverview(payload(rows), "2026-07-17T00:00:00Z", false);
  assertEquals(o.gesamt.waehrung, "EUR");
});

// --- Geld ---
Deno.test("Geldbetraege driften nicht", () => {
  const o = baueOrdersOverview(
    payload([pos({ id: "1", preis: "0.10" }), pos({ id: "2", preis: "0.20" })]),
    "2026-07-17T00:00:00Z",
    false
  );
  assertEquals(o.gesamt.umsatz, 0.3);
});

// --- Robustheit ---
Deno.test("leerer Report kippt nicht um", () => {
  const o = baueOrdersOverview(payload([]), "2026-07-17T00:00:00Z", false);
  assertEquals(o.gesamt.bestellungen, 0);
  assertEquals(o.gesamt.positionen, 0);
  assertEquals(o.gesamt.umsatz, 0);
  assertEquals(o.zeitraum, { von: null, bis: null });
  assertEquals(o.proKanal, []);
});

Deno.test("payload ohne rows kippt nicht um", () => {
  const o = baueOrdersOverview({}, "2026-07-17T00:00:00Z", false);
  assertEquals(o.gesamt.positionen, 0);
});

Deno.test("Zeitraum kommt aus den Bestelldaten", () => {
  const o = baueOrdersOverview(
    payload([
      pos({ id: "1", datum: "2026-07-03T09:23:58+00:00", preis: "1" }),
      pos({ id: "2", datum: "2026-06-21T14:41:05+00:00", preis: "1" }),
      pos({ id: "3", datum: "2026-07-16T19:22:54+00:00", preis: "1" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );
  assertEquals(o.zeitraum.von, "2026-06-21T14:41:05+00:00");
  assertEquals(o.zeitraum.bis, "2026-07-16T19:22:54+00:00");
});

// --- Der reale Datensatz vom 2026-07-17 ---
Deno.test("die 4 echten Bestellungen ergeben die erwarteten Zahlen", () => {
  const o = baueOrdersOverview(
    payload([
      pos({ id: "305-8636171-6113929", asin: "B0DNT2FDN9", menge: "1", preis: "7.85", kanal: "Amazon.de", status: "Pending", datum: "2026-07-16T19:22:54+00:00" }),
      pos({ id: "S02-9103052-7450912", asin: "B09JSHP49L", menge: "3", preis: "", kanal: "Non-Amazon", status: "Shipping", datum: "2026-07-17T09:21:56+00:00" }),
      pos({ id: "S02-9265542-9936140", asin: "B0DW43MJC9", menge: "8", preis: "", kanal: "Non-Amazon", status: "Shipped", datum: "2026-06-21T14:41:05+00:00" }),
      pos({ id: "408-0873648-0531529", asin: "B09JSHP49L", menge: "1", preis: "18.04", kanal: "Amazon.com.be", status: "Shipped", datum: "2026-07-03T09:23:58+00:00" }),
    ]),
    "2026-07-17T00:00:00Z",
    false
  );

  assertEquals(o.gesamt.bestellungen, 4);
  assertEquals(o.gesamt.positionen, 4);
  assertEquals(o.gesamt.einheiten, 13);
  assertEquals(o.gesamt.umsatz, 25.89); // nur die zwei bepreisten
  assertEquals(o.gesamt.umsatzEindeutig, true); // beide bepreisten haben quantity 1
  assertEquals(o.gesamt.positionenOhnePreis, 2);
  assertEquals(o.gesamt.einheitenOhnePreis, 11);
  assertEquals(o.gesamt.umsatzVollstaendig, false);
  assertEquals(o.gesamt.waehrung, "EUR");

  // 11 der 13 Einheiten haben keinen bekannten Preis — das MUSS sichtbar sein.
  assertEquals(o.warnungen.length >= 3, true);
});

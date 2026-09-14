import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { alsPeriode, letzterZeitraum, parseSqpReport, zeitraumFuer, zeitraumListe, alsMarktplatz, marktplatzName} from "./sqp.ts";

const beispiel = {
  dataByAsin: [
    {
      asin: "B01",
      searchQueryData: { searchQuery: "kratzbrett", searchQueryVolume: 20866 },
      impressionData: { totalQueryImpressionCount: 100000, asinImpressionCount: 5000 },
      clickData: { totalClickCount: 1240, asinClickCount: 59 },
      purchaseData: { totalPurchaseCount: 300, asinPurchaseCount: 11, asinPurchaseShare: 0.0364 },
    },
    {
      asin: "B01",
      searchQueryData: { searchQuery: "katzen kratzbrett", searchQueryVolume: 7108 },
      impressionData: { totalQueryImpressionCount: 40000, asinImpressionCount: 50 }, // wenig -> dünn
      clickData: { totalClickCount: 428, asinClickCount: 2 },
      purchaseData: { totalPurchaseCount: 100, asinPurchaseCount: 0, asinPurchaseShare: 0 },
    },
    { searchQueryData: { searchQuery: "" } }, // leere Query -> raus
  ],
};

Deno.test("berechnet eigene/Markt-CTR + Index", () => {
  const z = parseSqpReport(beispiel);
  const r = z[0];
  assertEquals(r.search_query, "kratzbrett");
  assertEquals(r.volume, 20866);
  assertEquals(r.eigene_ctr, 1.2); // 59/5000 = 1,18 -> 1,2
  assertEquals(r.markt_ctr, 1.2); // 1240/100000 = 1,24 -> 1,2
  assertEquals(r.ctr_index, 0.95); // (59/5000)/(1240/100000)
});

Deno.test("berechnet CVR + Kaufanteil", () => {
  const r = parseSqpReport(beispiel)[0];
  assertEquals(r.eigene_cvr, 18.6); // 11/59
  assertEquals(r.markt_cvr, 24.2); // 300/1240
  assertEquals(r.kaufanteil, 3.7); // 11/300 aus Zählwerten
});

Deno.test("markiert dünne Datenbasis (wenig eigene Impressions/Klicks)", () => {
  const z = parseSqpReport(beispiel);
  assertEquals(z[0].duenn, false);
  assertEquals(z[1].duenn, true);
});

Deno.test("leere Query wird gefiltert, leerer Report kippt nicht um", () => {
  assertEquals(parseSqpReport(beispiel).length, 2);
  assertEquals(parseSqpReport(null), []);
  assertEquals(parseSqpReport({}), []);
  assertEquals(parseSqpReport({ dataByAsin: [] }), []);
});

Deno.test("keine Division durch 0", () => {
  const z = parseSqpReport({ dataByAsin: [{ searchQueryData: { searchQuery: "x", searchQueryVolume: 5 }, impressionData: {}, clickData: {}, purchaseData: {} }] });
  assertEquals(z[0].eigene_ctr, null);
  assertEquals(z[0].markt_ctr, null);
  assertEquals(z[0].ctr_index, null);
});

/* --- Zeiträume ------------------------------------------------------------ */

Deno.test("Woche wird auf Sonntag–Samstag gelegt", () => {
  // 2026-07-22 ist ein Mittwoch.
  assertEquals(zeitraumFuer("WEEK", "2026-07-22"), { von: "2026-07-19", bis: "2026-07-25" });
  // Ränder bleiben in ihrer eigenen Woche.
  assertEquals(zeitraumFuer("WEEK", "2026-07-19"), { von: "2026-07-19", bis: "2026-07-25" });
  assertEquals(zeitraumFuer("WEEK", "2026-07-25"), { von: "2026-07-19", bis: "2026-07-25" });
});

Deno.test("Monat wird auf 1. bis Monatsletzten gelegt (auch Februar/Schaltjahr)", () => {
  assertEquals(zeitraumFuer("MONTH", "2026-07-22"), { von: "2026-07-01", bis: "2026-07-31" });
  assertEquals(zeitraumFuer("MONTH", "2026-02-14"), { von: "2026-02-01", bis: "2026-02-28" });
  assertEquals(zeitraumFuer("MONTH", "2028-02-14"), { von: "2028-02-01", bis: "2028-02-29" });
});

Deno.test("letzter Zeitraum ist immer abgeschlossen", () => {
  // Mittwoch, 2026-08-05 -> letzte volle Woche endete Samstag, 2026-08-01.
  assertEquals(letzterZeitraum("WEEK", "2026-08-05"), { von: "2026-07-26", bis: "2026-08-01" });
  // Sonntag: die gestern zu Ende gegangene Woche, nicht die laufende.
  assertEquals(letzterZeitraum("WEEK", "2026-08-02"), { von: "2026-07-26", bis: "2026-08-01" });
  // Samstag: die laufende Woche endet heute und zählt noch nicht.
  assertEquals(letzterZeitraum("WEEK", "2026-08-01"), { von: "2026-07-19", bis: "2026-07-25" });
  assertEquals(letzterZeitraum("MONTH", "2026-08-05"), { von: "2026-07-01", bis: "2026-07-31" });
  assertEquals(letzterZeitraum("MONTH", "2026-01-15"), { von: "2025-12-01", bis: "2025-12-31" });
});

Deno.test("Auswahlliste zählt lückenlos rückwärts", () => {
  const wochen = zeitraumListe("WEEK", 3, "2026-08-05");
  assertEquals(wochen, [
    { von: "2026-07-26", bis: "2026-08-01" },
    { von: "2026-07-19", bis: "2026-07-25" },
    { von: "2026-07-12", bis: "2026-07-18" },
  ]);
  const monate = zeitraumListe("MONTH", 3, "2026-03-10");
  assertEquals(monate, [
    { von: "2026-02-01", bis: "2026-02-28" },
    { von: "2026-01-01", bis: "2026-01-31" },
    { von: "2025-12-01", bis: "2025-12-31" },
  ]);
  assertEquals(zeitraumListe("WEEK", 0, "2026-08-05"), []);
});

Deno.test("Periode fällt auf WEEK zurück, Datum wird geprüft", () => {
  assertEquals(alsPeriode("MONTH"), "MONTH");
  assertEquals(alsPeriode("month"), "MONTH");
  assertEquals(alsPeriode("QUARTER"), "WEEK");
  assertEquals(alsPeriode(undefined), "WEEK");
  assertThrows(() => zeitraumFuer("WEEK", "letzte Woche"));
});

// --- Marktplatz -------------------------------------------------------------
//
// Der Bericht lief immer gegen den Marktplatz der Verbindung, also Deutschland.
// Frankreich war damit nicht abrufbar. Gefaehrlicher als "nicht moeglich" waere
// gewesen, es ohne eigenen Schluessel zuzulassen: Suchbegriffe und Kaufanteile
// sind je Land voellig verschieden, ein franzoesischer Abruf haette die
// deutschen Zeilen derselben ASIN und Woche ueberschrieben.

Deno.test("Marktplatz: Kuerzel, Name und ID werden erkannt", () => {
  assertEquals(alsMarktplatz("fr"), "A13V1IB3VIYZZH");
  assertEquals(alsMarktplatz("FR"), "A13V1IB3VIYZZH");
  assertEquals(alsMarktplatz("Amazon.fr"), "A13V1IB3VIYZZH");
  assertEquals(alsMarktplatz("A13V1IB3VIYZZH"), "A13V1IB3VIYZZH");
  assertEquals(alsMarktplatz("de"), "A1PA6795UKMFR9");
  assertEquals(alsMarktplatz("co.uk"), "A1F83G8C2ARO7P");
});

Deno.test("Marktplatz: nichts angegeben heisst nichts angegeben", () => {
  // null = "nimm den der Verbindung". Nicht Deutschland raten.
  assertEquals(alsMarktplatz(undefined), null);
  assertEquals(alsMarktplatz(""), null);
  assertEquals(alsMarktplatz("   "), null);
});

Deno.test("Marktplatz: Unbekanntes wird abgelehnt, nicht ersetzt", () => {
  // Ein Tippfehler im Land darf nicht als deutsche Zahlen zurueckkommen —
  // das waere still falsch statt sichtbar kaputt.
  let geworfen = false;
  try {
    alsMarktplatz("frankreich");
  } catch (e) {
    geworfen = true;
    assertEquals(String((e as Error).message).includes("nicht erkannt"), true);
    // Die Fehlermeldung nennt die erlaubten Werte, statt nur zu meckern.
    assertEquals(String((e as Error).message).includes("fr (A13V1IB3VIYZZH)"), true);
  }
  assertEquals(geworfen, true);
});

Deno.test("Marktplatz: Name zur ID, unbekannte ID bleibt stehen", () => {
  assertEquals(marktplatzName("A13V1IB3VIYZZH"), "Amazon.fr");
  assertEquals(marktplatzName("A1PA6795UKMFR9"), "Amazon.de");
  // Amazon legt Marktplaetze an, ohne uns zu fragen. Eine unbekannte ID als
  // "unbekannt" anzuzeigen waere weniger nuetzlich als die ID selbst.
  assertEquals(marktplatzName("AXXXNEU"), "AXXXNEU");
  assertEquals(marktplatzName(null), "—");
});

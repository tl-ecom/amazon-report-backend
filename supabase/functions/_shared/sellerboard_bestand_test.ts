import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  erkenneSpalten, istFeedNochNichtBereit, klassifiziereOrt, klassifiziereSpalte, marktplatzId, mengeGanz, parseBestandCsv,
} from "./sellerboard_bestand.ts";

Deno.test("mengeGanz: deutsche und englische Tausender, Dezimal, leer", () => {
  assertEquals(mengeGanz("1.350"), 1350);
  assertEquals(mengeGanz("1,350"), 1350);
  assertEquals(mengeGanz("1.234.567"), 1234567);
  assertEquals(mengeGanz("12,5"), 13);   // Stueckzahl, gerundet
  assertEquals(mengeGanz("820"), 820);
  assertEquals(mengeGanz(" 2 000 "), 2000);
  assertEquals(mengeGanz("0"), 0);
  assertEquals(mengeGanz(""), null);
  assertEquals(mengeGanz("-"), null);
  assertEquals(mengeGanz(null), null);
  assertEquals(mengeGanz("k. A."), null);
});

Deno.test("klassifiziereSpalte: Kennungen und Lagerarten", () => {
  assertEquals(klassifiziereSpalte("SKU"), { rolle: "sku" });
  assertEquals(klassifiziereSpalte("ASIN"), { rolle: "asin" });
  assertEquals(klassifiziereSpalte("Marketplace"), { rolle: "marktplatz" });
  assertEquals(klassifiziereSpalte("Title"), { rolle: "produktname" });
  assertEquals(klassifiziereSpalte("FBA stock"), { rolle: "bestand", lagerart: "fba_verfuegbar" });
  assertEquals(klassifiziereSpalte("Reserved"), { rolle: "bestand", lagerart: "fba_reserviert" });
  assertEquals(klassifiziereSpalte("Unsellable"), { rolle: "bestand", lagerart: "fba_unverkaeuflich" });
  assertEquals(klassifiziereSpalte("Sent to FBA"), { rolle: "bestand", lagerart: "inbound_fba" });
  assertEquals(klassifiziereSpalte("Inbound shipped"), { rolle: "bestand", lagerart: "inbound_fba" });
  assertEquals(klassifiziereSpalte("AWD"), { rolle: "bestand", lagerart: "awd" });
  assertEquals(klassifiziereSpalte("Prep Center"), { rolle: "bestand", lagerart: "prep_center" });
  assertEquals(klassifiziereSpalte("Zwischenlager"), { rolle: "bestand", lagerart: "prep_center" });
  assertEquals(klassifiziereSpalte("3PL"), { rolle: "bestand", lagerart: "dreipl" });
  assertEquals(klassifiziereSpalte("Logistiker"), { rolle: "bestand", lagerart: "dreipl" });
  assertEquals(klassifiziereSpalte("Ordered"), { rolle: "bestand", lagerart: "ordered" });
  assertEquals(klassifiziereSpalte("Purchase orders"), { rolle: "bestand", lagerart: "ordered" });
  assertEquals(klassifiziereSpalte("Bestellt"), { rolle: "bestand", lagerart: "ordered" });
  assertEquals(klassifiziereSpalte("Own warehouse"), { rolle: "bestand", lagerart: "extern_lager" });
  assertEquals(klassifiziereSpalte("Eigenes Lager"), { rolle: "bestand", lagerart: "extern_lager" });
  assertEquals(klassifiziereSpalte("In transit"), { rolle: "bestand", lagerart: "sonstige_pipeline" });
  assertEquals(klassifiziereSpalte("In transit to FBA"), { rolle: "bestand", lagerart: "inbound_fba" });
  // Nackter Bestand = FBA (Amazon-Klasse, wird bei SP-API-Daten nicht gezaehlt).
  assertEquals(klassifiziereSpalte("Stock"), { rolle: "bestand", lagerart: "fba_verfuegbar" });
});

Deno.test("klassifiziereSpalte: keine Mengen werden ausgeschlossen, nicht geraten", () => {
  assertEquals(klassifiziereSpalte("Reorder quantity").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Restock recommendation").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Days of stock").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Price").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Einkaufspreis").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Total").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Sales 30 days").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("FNSKU").rolle, "ignorieren");
  assertEquals(klassifiziereSpalte("Irgendwas"), { rolle: "unbekannt" });
});

Deno.test("klassifiziereOrt: Ortsnamen im Langformat", () => {
  assertEquals(klassifiziereOrt("Prep Center Berlin"), "prep_center");
  assertEquals(klassifiziereOrt("Lager Hamburg"), "extern_lager");
  assertEquals(klassifiziereOrt("DHL Fulfillment 3PL"), "dreipl");
  assertEquals(klassifiziereOrt("Supplier PO #4711"), "ordered");
  assertEquals(klassifiziereOrt("Amazon FBA"), "fba_verfuegbar");
  assertEquals(klassifiziereOrt("Keller"), "extern_lager"); // unbekannt = eigenes Lager
});

Deno.test("marktplatzId: Domain, Laendercode, Name, ID", () => {
  assertEquals(marktplatzId("amazon.de"), "A1PA6795UKMFR9");
  assertEquals(marktplatzId("www.amazon.co.uk"), "A1F83G8C2ARO7P");
  assertEquals(marktplatzId("DE"), "A1PA6795UKMFR9");
  assertEquals(marktplatzId("Deutschland"), "A1PA6795UKMFR9");
  assertEquals(marktplatzId("A1PA6795UKMFR9"), "A1PA6795UKMFR9");
  assertEquals(marktplatzId("Mars"), null);
  assertEquals(marktplatzId(""), null);
});

Deno.test("parseBestandCsv: Breitformat (Sellerboard, Semikolon, deutsche Zahlen)", () => {
  const csv = [
    "SKU;ASIN;Marketplace;Title;FBA stock;Reserved;Sent to FBA;Prep Center;Logistiker;Ordered;Days of stock;Price",
    "ZD-1;B0FKNN9CCJ;amazon.de;Obst Etagere;820;12;100;0;1.350;2.000;14;29,99",
    "CX10;B0D7D2NMT4;amazon.de;Biomuelleimer;;;;;40;;;9,99",
  ].join("\n");
  const r = parseBestandCsv(csv);
  assertEquals(r.erkannt.format, "breit");
  assertEquals(r.erkannt.sku, "SKU");
  assertEquals(r.erkannt.marktplatz, "Marketplace");
  assertEquals(r.erkannt.bestand.map((b) => b.lagerart), [
    "fba_verfuegbar", "fba_reserviert", "inbound_fba", "prep_center", "dreipl", "ordered",
  ]);
  assertEquals(r.erkannt.ignoriert.map((i) => i.spalte), ["Days of stock", "Price"]);
  assertEquals(r.erkannt.nicht_erkannt, []);
  // 2 Produkte x 6 Bestandsspalten
  assertEquals(r.zeilen.length, 12);
  const z1 = r.zeilen.filter((z) => z.sku === "ZD-1");
  assertEquals(z1.find((z) => z.lagerart === "dreipl")?.menge, 1350);
  assertEquals(z1.find((z) => z.lagerart === "ordered")?.menge, 2000);
  assertEquals(z1.find((z) => z.lagerart === "fba_verfuegbar")?.menge, 820);
  assertEquals(z1[0].marketplace_id, "A1PA6795UKMFR9");
  assertEquals(z1[0].produktname, "Obst Etagere");
  // Leere Felder sind unbekannt, nicht 0.
  const z2 = r.zeilen.filter((z) => z.sku === "CX10");
  assertEquals(z2.find((z) => z.lagerart === "fba_verfuegbar")?.menge, null);
  assertEquals(z2.find((z) => z.lagerart === "dreipl")?.menge, 40);
  assertEquals(r.uebersprungen, 0);
});

Deno.test("parseBestandCsv: Langformat (Ort + Menge je Zeile)", () => {
  const csv = [
    "sku,asin,location,quantity",
    "A-1,B000000001,Prep Center Berlin,300",
    "A-1,B000000001,Lager Hamburg,\"1,200\"",
    "A-1,B000000001,Supplier PO 77,500",
    "A-2,B000000002,,9",
  ].join("\n");
  const r = parseBestandCsv(csv);
  assertEquals(r.erkannt.format, "lang");
  assertEquals(r.erkannt.ort, "location");
  assertEquals(r.erkannt.menge, "quantity");
  assertEquals(r.zeilen.length, 3);
  assertEquals(r.zeilen[0], {
    sku: "A-1", asin: "B000000001", marktplatz_roh: "", marketplace_id: null, produktname: null,
    lagerart: "prep_center", lagername: "Prep Center Berlin", menge: 300,
  });
  assertEquals(r.zeilen[1].lagerart, "extern_lager");
  assertEquals(r.zeilen[1].menge, 1200);
  assertEquals(r.zeilen[2].lagerart, "ordered");
  assertEquals(r.uebersprungen, 1); // Zeile ohne Ort
});

Deno.test("parseBestandCsv: unbekannte Zahlenspalten werden benannt, nicht importiert", () => {
  const csv = "SKU,Warehouse,Foobar\nA-1,10,99\n";
  const r = parseBestandCsv(csv);
  assertEquals(r.erkannt.nicht_erkannt, ["Foobar"]);
  assertEquals(r.zeilen.length, 1);
  assertEquals(r.zeilen[0].lagerart, "extern_lager");
  assert(r.warnungen.some((w) => w.includes("Foobar")));
});

Deno.test("parseBestandCsv: ohne Kennung oder ohne Bestandsspalte -> leer mit Warnung", () => {
  assertEquals(parseBestandCsv("Title,Warehouse\nX,5\n").zeilen.length, 0);
  assertEquals(parseBestandCsv("SKU,Title\nA,X\n").zeilen.length, 0);
  assertEquals(parseBestandCsv("").warnungen, ["Der Feed ist leer."]);
  assert(parseBestandCsv("SKU,Warehouse\n").warnungen.some((w) => w.includes("Keine Datenzeilen")));
});

Deno.test("erkenneSpalten: einzelne Mengenspalte ohne Ort = FBA-Bestand", () => {
  const e = erkenneSpalten(["SKU", "Quantity"]);
  assertEquals(e.format, "breit");
  assertEquals(e.bestand, [{ spalte: "Quantity", lagerart: "fba_verfuegbar", klasse: "amazon" }]);
});

Deno.test("istFeedNochNichtBereit: Sellerboards Wartesatz statt CSV", () => {
  assertEquals(istFeedNochNichtBereit("﻿Report not ready, try again in several minutes"), true);
  assertEquals(istFeedNochNichtBereit("SKU;ASIN;Stock\nA;B;1"), false);
  assertEquals(istFeedNochNichtBereit(""), false);
});

// Vanejas echter Sellerboard-Export vom 10.09.2026 (Kopfzeile 1:1, Werte erfunden).
// Was hier steht, ist am Live-Sync gepruefte Realitaet, nicht die Doku.
Deno.test("erkenneSpalten: Vanejas echter Restock-Export", () => {
  const kopf = [
    "ASIN", "SKU", "Title", "Marketplace", "FBA/FBM Stock", "Running  out of stock", "Reserved", "Sent  to FBA",
    "Ordered", "Stock value", "Estimated Sales Velocity", "Days  of stock  left", "Recommended quantity for  reordering",
    "Time to  reorder", "Margin", "ROI, %", "Profit forecast (30 days)", "Comment", "Use a Prep Center",
    "Target stock range after new order days", "FBA buffer days", "Manuf. time days", "Shipping to Prep Center days",
    "Shipping to FBA days", "Supplier SKU", "Size", "Multipack size", "Box param length", "FNSKU",
    "FBA prep. stock Prep center 1 stock", "FBA prep. stock Prep center 2 stock", "On-hand stock",
    "Recommended ship-in quantity (by Amazon)", "Historical days of supply", "Missed profit (est)", "Color", "Item number",
  ];
  const e = erkenneSpalten(kopf);
  assertEquals(e.format, "breit");
  assertEquals(e.sku, "SKU");
  assertEquals(e.asin, "ASIN");
  assertEquals(e.marktplatz, "Marketplace");
  assertEquals(e.bestand.map((b) => [b.spalte, b.lagerart]), [
    ["FBA/FBM Stock", "fba_verfuegbar"],
    ["Reserved", "fba_reserviert"],
    ["Sent  to FBA", "inbound_fba"],
    ["Ordered", "ordered"],
    ["FBA prep. stock Prep center 1 stock", "prep_center"],
    ["FBA prep. stock Prep center 2 stock", "prep_center"],
  ]);
  const ignoriert = Object.fromEntries(e.ignoriert.map((i) => [i.spalte, i.grund]));
  assertEquals(ignoriert["Running  out of stock"], "Schalter/Flag");
  assertEquals(ignoriert["Use a Prep Center"], "Schalter/Flag");
  assertEquals(ignoriert["Supplier SKU"], "Stammdatum");
  assert(String(ignoriert["On-hand stock"]).startsWith("weitere FBA-Spalte"));
  // Kein physisch-externer Ort ausser den Prep Centern: nichts wird erfunden.
  assertEquals(e.bestand.filter((b) => b.klasse === "physisch_extern").length, 2);
});

Deno.test("erkenneSpalten: nur On-hand ohne FBA-Spalte bleibt als FBA erhalten", () => {
  const e = erkenneSpalten(["SKU", "On-hand stock", "Warehouse"]);
  assertEquals(e.bestand.map((b) => b.lagerart), ["fba_verfuegbar", "extern_lager"]);
});

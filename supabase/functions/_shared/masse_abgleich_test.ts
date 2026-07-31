import { assertEquals } from "jsr:@std/assert@1";
import { abgleichReport, pruefeMasse, type Paar } from "./masse_abgleich.ts";
import { baueKatalogMass, massCm, massG } from "./katalog.ts";

function paar(over: Partial<Paar> = {}): Paar {
  return {
    asin: "B0TEST", sku: "SKU-1", produktname: "Testprodukt",
    katalog: { laenge_cm: 30, breite_cm: 20, hoehe_cm: 10, gewicht_g: 800 },
    gemessen: { laengste_cm: 30, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
    gebuehr_cents: 344, gebuehr_soll_cents: 344, einheiten: 500,
    ...over,
  };
}

Deno.test("massCm / massG: Einheiten aus der Catalog-API", () => {
  assertEquals(massCm({ value: 30, unit: "centimeters" }), 30);
  assertEquals(massCm({ value: 10, unit: "inches" }), 25.4);
  assertEquals(massCm({ value: 300, unit: "millimeters" }), 30);
  // Unbekannte Einheit -> null. Ein Zollwert als cm gelesen wuerde eine
  // Massabweichung erfinden, die es nicht gibt.
  assertEquals(massCm({ value: 30, unit: "ellen" }), null);
  assertEquals(massG({ value: 1.2, unit: "kilograms" }), 1200);
  assertEquals(massG({ value: 800, unit: "grams" }), 800);
  assertEquals(massG({ value: 30, unit: "stone" }), null);
});

Deno.test("baueKatalogMass: nimmt NUR den Eintrag des richtigen Marktplatzes", () => {
  const item = {
    asin: "B0ABC",
    summaries: [{ marketplaceId: "A1PA6795UKMFR9", brand: "VANEJA" }],
    dimensions: [
      {
        marketplaceId: "A13V1IB3VIYZZH", // FR — darf NICHT gewinnen
        package: { length: { value: 99, unit: "centimeters" }, width: { value: 99, unit: "centimeters" },
                   height: { value: 99, unit: "centimeters" }, weight: { value: 9, unit: "kilograms" } },
      },
      {
        marketplaceId: "A1PA6795UKMFR9", // DE
        package: { length: { value: 30, unit: "centimeters" }, width: { value: 20, unit: "centimeters" },
                   height: { value: 10, unit: "centimeters" }, weight: { value: 0.8, unit: "kilograms" } },
        item: { length: { value: 28, unit: "centimeters" } },
      },
    ],
  };
  const k = baueKatalogMass(item, "A1PA6795UKMFR9", "DE")!;
  assertEquals(k.laenge_cm, 30);
  assertEquals(k.gewicht_g, 800);
  assertEquals(k.produkt_laenge_cm, 28);
  assertEquals(k.marke, "VANEJA");
});

Deno.test("baueKatalogMass: Marktplatz nicht dabei -> keine Masse statt falsche", () => {
  const k = baueKatalogMass({
    asin: "B0ABC",
    dimensions: [{ marketplaceId: "A13V1IB3VIYZZH", package: { length: { value: 99, unit: "centimeters" } } }],
  }, "A1PA6795UKMFR9", "DE")!;
  assertEquals(k.laenge_cm, null);
});

Deno.test("pruefeMasse: gleiche Masse in anderer Reihenfolge sind KEINE Abweichung", () => {
  // Der Verkaeufer traegt 10 x 30 x 20 ein, Amazon meldet 30/20/10.
  // Derselbe Karton — ein feldweiser Vergleich wuerde drei Abweichungen erfinden.
  const b = pruefeMasse(paar({ katalog: { laenge_cm: 10, breite_cm: 30, hoehe_cm: 20, gewicht_g: 800 } }));
  assertEquals(b.status, "stimmig");
  assertEquals(b.abweichungen.length, 0);
});

Deno.test("pruefeMasse: Amazon misst groesser UND es kostet -> Erstattungsfall", () => {
  const b = pruefeMasse(paar({
    gemessen: { laengste_cm: 36, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
    gebuehr_cents: 455, gebuehr_soll_cents: 344, einheiten: 500,
  }));
  assertEquals(b.status, "gebuehrenrelevant");
  assertEquals(b.abweichungen[0].richtung, "amazon_groesser");
  assertEquals(b.abweichungen[0].differenz, 6);
  assertEquals(b.mehrkosten_je_stueck, 1.11);
  assertEquals(b.mehrkosten_gesamt, 555);
  assertEquals(b.text.includes("Amazon-Support"), true);
});

Deno.test("pruefeMasse: Abweichung ohne Gebuehrenfolge ist Datenpflege", () => {
  const b = pruefeMasse(paar({
    gemessen: { laengste_cm: 32, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
    gebuehr_cents: 344, gebuehr_soll_cents: 344,
  }));
  assertEquals(b.status, "datenpflege");
  assertEquals(b.mehrkosten_gesamt, null); // nichts beziffert, wo nichts kostet
  assertEquals(b.text.includes("Kein Kostenthema"), true);
});

Deno.test("pruefeMasse: Messrauschen unter der Toleranz erzeugt keinen Befund", () => {
  const b = pruefeMasse(paar({
    gemessen: { laengste_cm: 30.4, mittlere_cm: 20.3, kuerzeste_cm: 10.2, gewicht_g: 840 },
  }));
  assertEquals(b.status, "stimmig");
});

Deno.test("pruefeMasse: Amazon misst KLEINER -> kein Erstattungsfall", () => {
  const b = pruefeMasse(paar({
    gemessen: { laengste_cm: 26, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
    gebuehr_cents: 344, gebuehr_soll_cents: 455, // Katalog waere teurer gewesen
  }));
  assertEquals(b.status, "datenpflege");
  assertEquals(b.abweichungen[0].richtung, "amazon_kleiner");
  assertEquals(b.mehrkosten_gesamt, null);
});

Deno.test("pruefeMasse: fehlende Katalogmasse -> nicht bewertbar, nie geraten", () => {
  const ohneKatalog = pruefeMasse(paar({ katalog: { laenge_cm: null, breite_cm: 20, hoehe_cm: 10, gewicht_g: 800 } }));
  assertEquals(ohneKatalog.status, "nicht_bewertbar");
  assertEquals(ohneKatalog.grund?.includes("Katalog"), true);

  const ohneMessung = pruefeMasse(paar({ gemessen: { laengste_cm: null, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 } }));
  assertEquals(ohneMessung.status, "nicht_bewertbar");
  assertEquals(ohneMessung.grund?.includes("Amazon"), true);
});

Deno.test("pruefeMasse: fehlendes Gewicht auf einer Seite blockiert den Massvergleich nicht", () => {
  const b = pruefeMasse(paar({
    katalog: { laenge_cm: 30, breite_cm: 20, hoehe_cm: 10, gewicht_g: null },
    gemessen: { laengste_cm: 36, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
    gebuehr_cents: 455, gebuehr_soll_cents: 344,
  }));
  assertEquals(b.status, "gebuehrenrelevant");
  assertEquals(b.abweichungen.map((x) => x.feld), ["laenge"]); // Gewicht nicht vergleichbar
});

Deno.test("abgleichReport: Kostenfaelle zuerst, nach Euro sortiert", () => {
  const r = abgleichReport([
    paar({ asin: "A", gemessen: { laengste_cm: 36, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
           gebuehr_cents: 455, gebuehr_soll_cents: 344, einheiten: 100 }),
    paar({ asin: "B", gemessen: { laengste_cm: 36, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 },
           gebuehr_cents: 455, gebuehr_soll_cents: 344, einheiten: 900 }),
    paar({ asin: "C", gemessen: { laengste_cm: 32, mittlere_cm: 20, kuerzeste_cm: 10, gewicht_g: 800 } }),
    paar({ asin: "D" }),
  ]);
  assertEquals(r.kosten.map((k) => k.asin), ["B", "A"]);
  assertEquals(r.pflege.length, 1);
  assertEquals(r.stimmig, 1);
  assertEquals(r.summe_mehrkosten, 1110);
  assertEquals(r.hinweis.includes("Mensch"), true);
});

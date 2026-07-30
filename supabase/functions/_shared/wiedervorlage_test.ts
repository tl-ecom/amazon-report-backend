import { assertEquals } from "jsr:@std/assert@1";
import {
  fasseLoopZusammen, messeEffekt, MIN_TAGE_NACHHER, proMonat, tageZwischen, tagPlus,
} from "./wiedervorlage.ts";

Deno.test("proMonat: normalisiert auf 30 Tage, unbekannt bleibt null", () => {
  assertEquals(proMonat(1000, 30), 1000);
  assertEquals(proMonat(500, 15), 1000); // hochgerechnet
  assertEquals(proMonat(null, 30), null);
  assertEquals(proMonat(1000, 0), null); // nie durch 0
});

Deno.test("messeEffekt: gemessen -> tatsächliche Veränderung pro Monat", () => {
  const m = messeEffekt({
    erwartet_eur_monat: 840,
    umsatz_vorher: 3000, tage_vorher: 30,
    umsatz_nachher: 3610, tage_nachher: 30,
  });
  assertEquals(m.ergebnis, "gemessen");
  assertEquals(m.vorher_eur_monat, 3000);
  assertEquals(m.nachher_eur_monat, 3610);
  assertEquals(m.tatsaechlich_eur_monat, 610); // Brief-Beispiel
  assertEquals(m.erwartet_eur_monat, 840);
});

Deno.test("messeEffekt: negative Veränderung wird ehrlich ausgewiesen", () => {
  const m = messeEffekt({ erwartet_eur_monat: 500, umsatz_vorher: 3000, tage_vorher: 30, umsatz_nachher: 2500, tage_nachher: 30 });
  assertEquals(m.tatsaechlich_eur_monat, -500);
});

Deno.test("messeEffekt: zu kurz nach dem Erledigen -> zu_frueh, keine Zahl", () => {
  const m = messeEffekt({ erwartet_eur_monat: 840, umsatz_vorher: 3000, tage_vorher: 30, umsatz_nachher: 500, tage_nachher: MIN_TAGE_NACHHER - 1 });
  assertEquals(m.ergebnis, "zu_frueh");
  assertEquals(m.tatsaechlich_eur_monat, null);
  assertEquals(m.hinweis?.includes(String(MIN_TAGE_NACHHER)), true);
});

Deno.test("messeEffekt: fehlende Umsatzdaten -> nicht_messbar, nie 0", () => {
  const m = messeEffekt({ erwartet_eur_monat: 840, umsatz_vorher: null, tage_vorher: 30, umsatz_nachher: 3000, tage_nachher: 30 });
  assertEquals(m.ergebnis, "nicht_messbar");
  assertEquals(m.tatsaechlich_eur_monat, null);
});

Deno.test("messeEffekt: ungleiche Fensterlängen werden normalisiert", () => {
  // 1500 € in 15 Tagen = 3000 €/Monat; vorher 2000 in 30 T = 2000 -> +1000
  const m = messeEffekt({ erwartet_eur_monat: 900, umsatz_vorher: 2000, tage_vorher: 30, umsatz_nachher: 1500, tage_nachher: 15 });
  assertEquals(m.tatsaechlich_eur_monat, 1000);
});

Deno.test("fasseLoopZusammen: Brief-Zeile (3 Maßnahmen, 2 erledigt, erwartet vs. tatsächlich)", () => {
  const massnahmen = [{ status: "erledigt" }, { status: "erledigt" }, { status: "offen" }];
  const messungen = [
    messeEffekt({ erwartet_eur_monat: 600, umsatz_vorher: 2000, tage_vorher: 30, umsatz_nachher: 2400, tage_nachher: 30 }),
    messeEffekt({ erwartet_eur_monat: 240, umsatz_vorher: 1000, tage_vorher: 30, umsatz_nachher: 1210, tage_nachher: 30 }),
  ];
  const z = fasseLoopZusammen(massnahmen, messungen);
  assertEquals(z.massnahmen_gesamt, 3);
  assertEquals(z.erledigt, 2);
  assertEquals(z.offen, 1);
  assertEquals(z.erwartet_eur_monat, 840);
  assertEquals(z.tatsaechlich_eur_monat, 610);
  assertEquals(z.gemessen, 2);
});

Deno.test("fasseLoopZusammen: tatsächlich summiert NUR Gemessenes (kein Mischwert)", () => {
  const messungen = [
    messeEffekt({ erwartet_eur_monat: 600, umsatz_vorher: 2000, tage_vorher: 30, umsatz_nachher: 2400, tage_nachher: 30 }),
    messeEffekt({ erwartet_eur_monat: 900, umsatz_vorher: 2000, tage_vorher: 30, umsatz_nachher: 900, tage_nachher: 3 }), // zu früh
  ];
  const z = fasseLoopZusammen([{ status: "erledigt" }, { status: "erledigt" }], messungen);
  assertEquals(z.erwartet_eur_monat, 1500); // Erwartung zählt beide
  assertEquals(z.tatsaechlich_eur_monat, 400); // gemessen nur die erste
  assertEquals(z.zu_frueh, 1);
  assertEquals(z.gemessen, 1);
});

Deno.test("fasseLoopZusammen: nichts messbar -> tatsächlich null statt 0", () => {
  const z = fasseLoopZusammen([{ status: "erledigt" }], [
    messeEffekt({ erwartet_eur_monat: 500, umsatz_vorher: null, tage_vorher: 30, umsatz_nachher: null, tage_nachher: 30 }),
  ]);
  assertEquals(z.tatsaechlich_eur_monat, null);
  assertEquals(z.nicht_messbar, 1);
});

Deno.test("fasseLoopZusammen nennt die Grenze der Messung (keine Kausalität)", () => {
  const z = fasseLoopZusammen([], []);
  assertEquals(z.hinweis.includes("kein Kausalitätsnachweis"), true);
});

Deno.test("Datums-Helfer: tagPlus über Monatsgrenze, tageZwischen nie negativ", () => {
  assertEquals(tagPlus("2026-06-29", 3), "2026-07-02");
  assertEquals(tagPlus("2026-07-15", -30), "2026-06-15");
  assertEquals(tageZwischen("2026-07-01", "2026-07-31"), 30);
  assertEquals(tageZwischen("2026-07-31", "2026-07-01"), 0);
});

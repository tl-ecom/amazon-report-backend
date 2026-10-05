// Tests für ads_produkt_verlauf.ts. Zahlen: Vanejas Kratzbrett, 18.–25.09.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueVerlauf, mitEreignissen, type VerlaufZeile } from "./ads_produkt_verlauf.ts";

const z = (datum: string, spend_cents: number, sales_cents: number, umsatz_cents: number, einheiten: number): VerlaufZeile =>
  ({ produkt: "Kratzbrett", datum, spend_cents, sales_cents, orders: 0, clicks: 0, umsatz_cents, einheiten });

const KRATZ = [
  z("2026-09-19", 6211, 9982, 20378, 12), z("2026-09-18", 5922, 12834, 40742, 24),
  z("2026-09-20", 7909, 19042, 55448, 32), z("2026-09-21", 2891, 3356, 25961, 13),
  z("2026-09-22", 3795, 3356, 5991, 3), z("2026-09-23", 3395, 6712, 11982, 6),
  z("2026-09-24", 3494, 10906, 16573, 9), z("2026-09-25", 2554, 7550, 10782, 6),
];

Deno.test("Verlauf: nach Datum sortiert, Woche erst ab dem siebten Tag", () => {
  const [k] = baueVerlauf(KRATZ);
  assertEquals(k.tage.map((t) => t.datum)[0], "2026-09-18");
  assertEquals(k.tage[5].woche, null);
  // 18.–24.09.: 1.770,75 EUR gesamt, 661,88 EUR Werbung.
  assertEquals(k.tage[6].woche!.gesamtumsatz, 1770.75);
  assertEquals(k.tage[6].woche!.werbeumsatz, 661.88);
  assertEquals(k.tage[6].woche!.ohne_werbung, 1108.87);
  assertEquals(k.tage[6].woche!.tacos, 0.1898);
  // Das Fenster wandert: der 18.09. fällt heraus, der 25.09. kommt dazu.
  assertEquals(k.tage[7].woche!.gesamtumsatz, 1471.15);
});

Deno.test("Verlauf: Tag mit mehr Werbe- als Gesamtumsatz bleibt negativ stehen, wird nicht auf 0 gebogen", () => {
  const [k] = baueVerlauf([z("2026-09-22", 100, 5000, 3000, 1)]);
  assertEquals(k.tage[0].ohne_werbung, -20);
});

Deno.test("Ereignisse: je Produkt, nach Datum, Mengen im Text", () => {
  // Vanejas Kratzbrett im September 2026.
  const [k, b] = mitEreignissen([{ produkt: "Kratzbrett" }, { produkt: "Biomülleimer" }], [
    { produkt: "Kratzbrett", datum: "2026-09-18", art: "preis", text: "Preis 17.97 → 16.97 EUR (B0FLKN42D4)", anzahl: 1 },
    { produkt: "Kratzbrett", datum: "2026-09-04", art: "werbung", text: "Gebote über Pulse geändert", anzahl: 31 },
    { produkt: "Biomülleimer", datum: "2026-09-27", art: "listing_aus", text: "Listing inaktiv (B0D7D2NMT4)", anzahl: 1 },
  ]);
  assertEquals(k.ereignisse.map((e) => e.text), ["31 Gebote über Pulse geändert", "Preis 17.97 → 16.97 EUR (B0FLKN42D4)"]);
  assertEquals(b.ereignisse[0].text, "Ein Angebot inaktiv (B0D7D2NMT4)");
});

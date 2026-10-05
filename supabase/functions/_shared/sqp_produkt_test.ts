// Tests für sqp_produkt.ts. Zahlen: Vanejas Biomülleimer (B0D7D2NMT4), Wochen 19.07.–19.09.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueSqpProdukt, type ProduktRoh } from "./sqp_produkt.ts";

const BIO: ProduktRoh = {
  produkt: "Biomülleimer", asins: ["B0D7D2NMT4"], kern_begriffe: 18,
  wochen: [
    { von: "2026-07-19", bis: "2026-07-25", begriffe: 100, kern_volumen: 26656, kern_kaufanteil: 2.96 },
    { von: "2026-08-16", bis: "2026-08-22", begriffe: 100, kern_volumen: 29774, kern_kaufanteil: 6.91 },
    { von: "2026-09-06", bis: "2026-09-12", begriffe: 100, kern_volumen: 31125, kern_kaufanteil: 2.57 },
    { von: "2026-09-13", bis: "2026-09-19", begriffe: 100, kern_volumen: 30411, kern_kaufanteil: 1.15 },
  ],
  begriffe: [
    { begriff: "biomülleimer küche", kern: true, wochen: [
      { von: "2026-07-19", volumen: 12617, kaufanteil: 2, duenn: false },
      { von: "2026-08-16", volumen: 14078, kaufanteil: 6.1, duenn: false },
      { von: "2026-09-06", volumen: 14575, kaufanteil: 3, duenn: false },
      { von: "2026-09-13", volumen: 14188, kaufanteil: 1.3, duenn: false },
    ] },
    { begriff: "biomülleimer küche gegen fruchtfliegen", kern: false, wochen: [
      { von: "2026-08-16", volumen: 310, kaufanteil: 33.3, duenn: true },
    ] },
  ],
};

Deno.test("SQP je Produkt: Markt stabil, Anteil gefallen", () => {
  const p = baueSqpProdukt(BIO);
  // Das Suchvolumen des Kerns stieg um 14 %, der Kaufanteil fiel um 1,81 Punkte — vom Höchststand 6,91.
  assertEquals(p.kern_verlauf, {
    von: "2026-07-19", bis: "2026-09-13", volumen_differenz_prozent: 14.09, kaufanteil_differenz: -1.81, kaufanteil_hoechst: 6.91,
  });
  const k = p.begriffe[0];
  assertEquals([k.volumen, k.kaufanteil, k.kaufanteil_davor, k.kaufanteil_hoechst, k.hoechst_in_woche], [14188, 1.3, 3, 6.1, "2026-08-16"]);
});

Deno.test("SQP je Produkt: Begriff nicht mehr unter den 100 ist unbekannt, nicht 0", () => {
  const f = baueSqpProdukt(BIO).begriffe[1];
  assertEquals([f.volumen, f.kaufanteil, f.kaufanteil_davor, f.duenn], [null, null, null, null]);
  assertEquals(f.kaufanteil_hoechst, 33.3);
});

Deno.test("SQP je Produkt: eine einzige Woche ergibt keinen Verlauf", () => {
  const p = baueSqpProdukt({ ...BIO, wochen: BIO.wochen!.slice(0, 1), begriffe: [] });
  assertEquals(p.kern_verlauf, null);
  assertEquals(baueSqpProdukt({ produkt: "X", asins: null, kern_begriffe: 0, wochen: null, begriffe: null }).wochen, []);
});

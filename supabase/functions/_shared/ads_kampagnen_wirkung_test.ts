// Tests für ads_kampagnen_wirkung.ts. Alle Zahlen sind Vanejas echte Zeilen aus
// dem Lauf vom 05.10.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueKampagnenWirkung, type WirkungZeile } from "./ads_kampagnen_wirkung.ts";

function zeile(ueber: Partial<WirkungZeile> = {}): WirkungZeile {
  return {
    campaign_id: "C1", campaign_name: "CP-sp_kw_exact_manual_etagere_vaneja_de",
    feld: "mod_top", platzierung: "Top of Search on-Amazon", vorher: 20, nachher: 50,
    am: "2026-09-09T16:26:00Z", fenster_ab: null, quelle: "pulse_log", grund: "Etagere-Strukturstraffung",
    nachlauf_vollstaendig: true,
    davor: { clicks: 45, spend_cents: 2896, sales_cents: 15746, orders: 4 },
    danach: { clicks: 394, spend_cents: 33837, sales_cents: 79356, orders: 22 },
    platz_davor: { clicks: 3, spend_cents: 239, sales_cents: 0, orders: 0 },
    platz_danach: { clicks: 135, spend_cents: 13305, sales_cents: 18473, orders: 5 },
    ...ueber,
  };
}

Deno.test("Platzierung: zu wenig Klicks davor an der Platzierung — benannt, die Kampagne steht trotzdem da", () => {
  // Top of Search 20 → 50 %: an der Platzierung davor nur 3 Klicks.
  const w = baueKampagnenWirkung(zeile());
  assertEquals([w.vergleichbar, w.urteil, w.urteil_ebene], [false, null, "platzierung"]);
  assertEquals(w.grund?.includes("3 Klicks davor, 135 danach an dieser Platzierung"), true);
  // Der zweite Blick: die Kampagne machte 636 € mehr Umsatz — für 309 € mehr Kosten.
  assertEquals([w.kampagne_umsatz_differenz, w.kampagne_kosten_differenz], [636.1, 309.41]);
  assertEquals(w.richtung, "hoch");
});

Deno.test("Platzierung: Urteil steht auf der Platzierung, nicht auf der Kampagne", () => {
  // Kratzbrett ASIN Exact, 17.09.: Top of Search 35 → 10 %.
  const w = baueKampagnenWirkung(zeile({
    vorher: 35, nachher: 10,
    davor: { clicks: 88, spend_cents: 9375, sales_cents: 20888, orders: 14 },
    danach: { clicks: 16, spend_cents: 1395, sales_cents: 4530, orders: 2 },
    platz_davor: { clicks: 54, spend_cents: 6353, sales_cents: 13254, orders: 9 },
    platz_danach: { clicks: 4, spend_cents: 374, sales_cents: 2852, orders: 1 },
  }));
  // 4 Klicks danach an der Platzierung: unter der Schwelle, also kein Urteil —
  // obwohl die Kampagne mit 16 Klicks darüber läge.
  assertEquals([w.vergleichbar, w.urteil], [false, null]);
  assertEquals(w.kampagne_umsatz_differenz, -163.58);
});

Deno.test("Budget: gesenkt, und die Kampagne bricht ein", () => {
  // SPM Biomülleimer SK Rank, 06.09.: 30 → 12 €.
  const w = baueKampagnenWirkung(zeile({
    feld: "budget", platzierung: null, vorher: 30, nachher: 12, platz_davor: null, platz_danach: null,
    davor: { clicks: 107, spend_cents: 12095, sales_cents: 36901, orders: 16 },
    danach: { clicks: 42, spend_cents: 3167, sales_cents: 8728, orders: 4 },
  }));
  assertEquals([w.richtung, w.urteil_ebene, w.vergleichbar], ["runter", "kampagne", true]);
  // ROAS 3,05 → 2,76 und Umsatz runter.
  assertEquals(w.urteil, "beides_schlechter");
  assertEquals([w.umsatz_differenz, w.kosten_differenz], [-281.73, -89.28]);
});

Deno.test("Budget: Nachlauf noch nicht vollständig — kein Urteil, keine Differenz", () => {
  const w = baueKampagnenWirkung(zeile({
    feld: "budget", platzierung: null, vorher: 10, nachher: 6, platz_davor: null, platz_danach: null,
    quelle: "snapshot", fenster_ab: "2026-10-04T02:05:00Z", nachlauf_vollstaendig: false,
    danach: { clicks: 0, spend_cents: 0, sales_cents: 0, orders: 0 },
  }));
  assertEquals([w.vergleichbar, w.urteil, w.kampagne_umsatz_differenz], [false, null, null]);
  assertEquals(w.grund?.includes("noch nicht vollständig"), true);
});

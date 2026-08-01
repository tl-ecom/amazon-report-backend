import { assertEquals } from "jsr:@std/assert@1";
import { findeLeerphasen, tageZwischen, type TagesStand } from "./bestandshistorie.ts";

/** Tagesreihe ab `start`: eine Zahl je Tag; `null` = an dem Tag KEINE Report-Zeile. */
function reihe(start: string, mengen: (number | null)[], verkauft: number[] = []): TagesStand[] {
  const out: TagesStand[] = [];
  for (let i = 0; i < mengen.length; i++) {
    const m = mengen[i];
    if (m === null) continue;
    const d = new Date(Date.parse(start + "T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ datum: d, menge: m, verkauft: verkauft[i] ?? 0 });
  }
  return out;
}

Deno.test("tageZwischen zaehlt inklusive, auch ueber Monatsgrenzen", () => {
  assertEquals(tageZwischen("2026-03-01", "2026-03-01"), 1);
  assertEquals(tageZwischen("2026-02-27", "2026-03-02"), 4);
});

Deno.test("ohne Messwerte gibt es kein Urteil", () => {
  assertEquals(findeLeerphasen([]), null);
});

Deno.test("durchgehend Bestand -> keine Leerphase", () => {
  const h = findeLeerphasen(reihe("2026-01-01", [5, 4, 3, 2, 1]))!;
  assertEquals(h.phasen.length, 0);
  assertEquals(h.tage_leer, 0);
  assertEquals(h.anteil_leer, 0);
  assertEquals(h.aktuell_leer, false);
  assertEquals(h.abdeckung_tage, 5);
});

Deno.test("abgeschlossene Leerphase hat Anfang, Ende und Dauer", () => {
  //             01 02 03 04 05 06
  const h = findeLeerphasen(reihe("2026-01-01", [3, 0, 0, 0, 7, 6]))!;
  assertEquals(h.phasen.length, 1);
  assertEquals(h.phasen[0].von, "2026-01-02");
  assertEquals(h.phasen[0].bis, "2026-01-04");
  assertEquals(h.phasen[0].tage, 3);
  assertEquals(h.phasen[0].laufend, false);
  assertEquals(h.tage_leer, 3);
  assertEquals(h.aktuell_leer, false);
});

Deno.test("am letzten Messtag noch leer -> laufend, kein erfundenes Ende", () => {
  const h = findeLeerphasen(reihe("2026-01-01", [3, 0, 0]))!;
  assertEquals(h.phasen[0].von, "2026-01-02");
  assertEquals(h.phasen[0].bis, null);
  assertEquals(h.phasen[0].tage, 2);
  assertEquals(h.phasen[0].laufend, true);
  assertEquals(h.aktuell_leer, true);
});

Deno.test("Tage ohne Report-Zeile werden fortgeschrieben, NICHT auf 0 gesetzt", () => {
  // Bestand 5, drei Tage ohne Bewegung (= ohne Zeile), dann wieder 5.
  const h = findeLeerphasen(reihe("2026-01-01", [5, null, null, null, 5]))!;
  assertEquals(h.phasen.length, 0);      // keine erfundene Leerphase
  assertEquals(h.gemessene_tage, 2);
  assertEquals(h.luecken_tage, 3);
  assertEquals(h.abdeckung_tage, 5);
});

Deno.test("nach einer 0 gilt die Luecke als weiterhin leer und wird ausgewiesen", () => {
  const h = findeLeerphasen(reihe("2026-01-01", [2, 0, null, null, 4]))!;
  assertEquals(h.phasen.length, 1);
  assertEquals(h.phasen[0].von, "2026-01-02");
  assertEquals(h.phasen[0].bis, "2026-01-04");
  assertEquals(h.phasen[0].tage, 3);
  assertEquals(h.phasen[0].luecken_tage, 2); // 2 der 3 Tage sind fortgeschrieben
});

Deno.test("Geschwindigkeit zaehlt nur Tage MIT Bestand", () => {
  // 4 Tage mit Bestand, je 2 Stueck verkauft; dazwischen 2 leere Tage.
  const h = findeLeerphasen(reihe(
    "2026-01-01",
    [10, 8, 0, 0, 6, 4],
    [2, 2, 0, 0, 2, 2],
  ))!;
  assertEquals(h.velo_tag, 2);                       // nicht 8/6 = 1,33
  assertEquals(h.tage_leer, 2);
  assertEquals(h.phasen[0].entgangene_einheiten, 4); // 2 Stk/Tag x 2 Tage
  assertEquals(h.entgangene_einheiten, 4);
});

Deno.test("ohne einen einzigen Tag mit Bestand bleibt die Schaetzung null, nicht 0", () => {
  const h = findeLeerphasen(reihe("2026-01-01", [0, 0, 0]))!;
  assertEquals(h.velo_tag, null);
  assertEquals(h.entgangene_einheiten, null);
  assertEquals(h.phasen[0].entgangene_einheiten, null);
  assertEquals(h.phasen[0].tage, 3);
});

Deno.test("mindest_tage blendet kurze Phasen nur AUS DER LISTE aus", () => {
  //                                 01 02 03 04 05 06 07
  const staende = reihe("2026-01-01", [5, 0, 5, 0, 0, 0, 5]);
  const h = findeLeerphasen(staende, { mindest_tage: 2 })!;
  assertEquals(h.phasen.length, 1);            // der Ein-Tages-Ausfall fliegt raus
  assertEquals(h.phasen[0].tage, 3);
  assertEquals(h.tage_leer, 4);                // gezaehlt wird er trotzdem
  assertEquals(h.laengste_phase_tage, 3);
  assertEquals(Math.round(h.anteil_leer * 100), 57); // 4 von 7 Tagen
});

Deno.test("mehrere Phasen: laengste und Gesamtdauer stimmen", () => {
  const h = findeLeerphasen(reihe("2026-01-01", [5, 0, 5, 0, 0, 5, 0, 0, 0, 5]))!;
  assertEquals(h.phasen.length, 3);
  assertEquals(h.phasen.map((p) => p.tage), [1, 2, 3]);
  assertEquals(h.laengste_phase_tage, 3);
  assertEquals(h.tage_leer, 6);
});

Deno.test("Phasen ueber die Monatsgrenze behalten die richtigen Daten", () => {
  const h = findeLeerphasen(reihe("2026-02-26", [4, 0, 0, 0, 0, 9]))!;
  assertEquals(h.phasen[0].von, "2026-02-27");
  assertEquals(h.phasen[0].bis, "2026-03-02"); // 2026 ist kein Schaltjahr
  assertEquals(h.phasen[0].tage, 4);
});

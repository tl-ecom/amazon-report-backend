// Tests für cashflow_werbung.ts.
//
// Die Zahlen sind Vanejas Juli, so wie ertrag_abgerechnet ihn liefert:
// 47.802,94 € Nettoumsatz, 14.940,22 € Deckungsbeitrag vor Werbung,
// 9.793,32 € Werbung, Geldlauf 18 Tage. Daraus folgen 31,3 % Break-even-ACOS
// und 20,5 % TACOS — der Abstand dazwischen ist der Spielraum, um den es
// im Coaching tatsächlich geht.

import { assertEquals } from "jsr:@std/assert@1";
import { tageImMonat, werbeSzenarien, type DbEingabe } from "./cashflow_werbung.ts";

const JULI: DbEingabe = {
  monat: "2026-07",
  netto_umsatz: 47802.94,
  db_vor_werbung: 14940.22,
  werbung: 9793.32,
  tage_im_monat: 31,
};

Deno.test("Werbung: gebundenes Kapital ist Erhöhung mal Geldlauf", () => {
  const s = werbeSzenarien(386.85, 18, JULI, [100]);
  const z = s.szenarien[0];
  // 100 € am Tag, 18 Tage unterwegs = 1.800 € dauerhaft gebunden.
  assertEquals(z.gebunden_zusaetzlich, 1800);
  assertEquals(z.budget_je_tag, 486.85);
  assertEquals(z.gebunden_gesamt, 8763.3);
  // Der Sockel steht dauerhaft — das gehört als Satz dazu, nicht als Fussnote.
  assertEquals(s.hinweise.some((h) => h.includes("dauerhaft")), true);
});

Deno.test("Werbung: Break-even-ACOS ist der Deckungsbeitrag vor Werbung", () => {
  const s = werbeSzenarien(386.85, 18, JULI);
  // 14.940,22 / 47.802,94 = 31,25 %.
  assertEquals(s.db_quote, 0.3125);
  assertEquals(s.break_even_acos, 0.3125);
  // 9.793,32 / 47.802,94 = 20,49 %.
  assertEquals(s.tacos, 0.2049);
  assertEquals(s.db_monat, "2026-07");
});

Deno.test("Werbung: nötiger Mehrumsatz folgt aus dem Deckungsbeitrag", () => {
  const s = werbeSzenarien(386.85, 18, JULI, [100]);
  // 100 € Werbung tragen sich erst, wenn sie 100/0,3125 = 320 € Nettoumsatz
  // bringen. Das ist die Zahl, die man prüfen kann — anders als eine Prognose,
  // wieviel Umsatz mehr Budget angeblich bringt.
  assertEquals(s.szenarien[0].noetiger_mehrumsatz_je_tag, 320);
});

Deno.test("Werbung: Puffer bis Ergebnis null, bei gleichem Umsatz", () => {
  const s = werbeSzenarien(386.85, 18, JULI);
  // 14.940,22 − 9.793,32 = 5.146,90 übrig, auf 31 Tage = 166,03 € am Tag.
  assertEquals(s.puffer_je_tag, 166.03);
});

Deno.test("Werbung: Monat schon bei null — dann ist mehr Budget keine Frage mehr", () => {
  const s = werbeSzenarien(386.85, 18, {
    ...JULI, werbung: 15500,
  });
  assertEquals((s.puffer_je_tag ?? 0) < 0, true);
  assertEquals(s.hinweise.some((h) => h.includes("beschleunigt")), true);
});

Deno.test("Werbung: ohne Geldlauf wird nichts gerechnet", () => {
  const s = werbeSzenarien(386.85, null, JULI);
  // Die Bindung HÄNGT am Geldlauf. Ohne ihn gibt es keine Zahl, nur den Grund.
  assertEquals(s.szenarien, []);
  assertEquals(s.grund?.includes("Ohne gemessenen Geldlauf"), true);
});

Deno.test("Werbung: ohne Deckungsbeitrag bleibt die Liquiditätswirkung stehen", () => {
  const s = werbeSzenarien(386.85, 18, null, [100]);
  // Wieviel Kapital gebunden wird, hängt NICHT am Deckungsbeitrag — diese
  // Aussage darf nicht mit verschwinden.
  assertEquals(s.szenarien[0].gebunden_zusaetzlich, 1800);
  assertEquals(s.szenarien[0].noetiger_mehrumsatz_je_tag, null);
  assertEquals(s.break_even_acos, null);
  assertEquals(s.hinweise.some((h) => h.includes("hängt nicht am Deckungsbeitrag")), true);
});

Deno.test("Werbung: ohne heutiges Budget bleibt die Erhöhung trotzdem rechenbar", () => {
  const s = werbeSzenarien(null, 18, JULI, [100]);
  assertEquals(s.szenarien[0].gebunden_zusaetzlich, 1800);
  // Was man ohne Ausgangswert nicht sagen kann, bleibt null statt 0.
  assertEquals(s.szenarien[0].budget_je_tag, null);
  assertEquals(s.szenarien[0].gebunden_gesamt, null);
});

Deno.test("Tage im Monat: Schaltjahr und kurze Monate", () => {
  assertEquals(tageImMonat("2026-07"), 31);
  assertEquals(tageImMonat("2026-09"), 30);
  assertEquals(tageImMonat("2026-02"), 28);
  assertEquals(tageImMonat("2028-02"), 29);
});

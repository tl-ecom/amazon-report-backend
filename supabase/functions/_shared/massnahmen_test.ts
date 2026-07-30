import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  MAX_OFFENE, pruefeMassnahme, pruefeStatusWechsel, schlageMassnahmenVor, summeEffekt,
} from "./massnahmen.ts";

const AUSSERHALB = [
  { kennzahl: "cvr", label: "Conversion Rate", ist: 3, min: 8, max: null, delta_eur_monat: 120 },
  { kennzahl: "tacos", label: "TACoS", ist: 28, min: 12, max: 20, delta_eur_monat: 900 },
  { kennzahl: "bestandsreichweite", label: "Bestandsreichweite", ist: 5, min: 30, max: null, delta_eur_monat: 400 },
  { kennzahl: "acos", label: "ACoS", ist: 60, min: null, max: 35, delta_eur_monat: 50 },
];

Deno.test("Vorschläge: nach Euro sortiert und auf 3 gekürzt", () => {
  const v = schlageMassnahmenVor({ ausserhalb: AUSSERHALB });
  assertEquals(v.length, MAX_OFFENE);
  assertEquals(v.map((m) => m.kennzahl), ["tacos", "bestandsreichweite", "cvr"]); // 900, 400, 120
});

Deno.test("Vorschläge: Richtung bestimmt die Handlung (zu hoch vs. zu niedrig)", () => {
  const hoch = schlageMassnahmenVor({ ausserhalb: [AUSSERHALB[1]] })[0]; // TACoS 28 > 20
  assertEquals(hoch.text.includes("senken"), true);
  const tief = schlageMassnahmenVor({ ausserhalb: [AUSSERHALB[0]] })[0]; // CVR 3 < 8
  assertEquals(tief.text.includes("Listing prüfen"), true);
});

Deno.test("Vorschläge: Euro-Effekt wird durchgereicht, auch wenn unbekannt", () => {
  const v = schlageMassnahmenVor({ ausserhalb: [{ ...AUSSERHALB[0], delta_eur_monat: null }] });
  assertEquals(v[0].effekt_eur, null);
});

Deno.test("Vorschläge: leere Fakten -> keine Maßnahmen", () => {
  assertEquals(schlageMassnahmenVor({}).length, 0);
  assertEquals(schlageMassnahmenVor({ ausserhalb: [] }).length, 0);
});

Deno.test("pruefeMassnahme: gültige Maßnahme wird gerundet übernommen", () => {
  const m = pruefeMassnahme({ text: "Gebote der Verlust-Keywords senken", effekt_eur: 123.456 }, 0);
  assertEquals(m.effekt_eur, 123.46);
});

Deno.test("pruefeMassnahme: ohne Eurobetrag -> Fehler (Brief-Regel)", () => {
  assertThrows(() => pruefeMassnahme({ text: "Irgendwas tun", effekt_eur: null }, 0));
  assertThrows(() => pruefeMassnahme({ text: "Irgendwas tun", effekt_eur: "" }, 0));
});

Deno.test("pruefeMassnahme: ohne konkrete Handlung -> Fehler", () => {
  assertThrows(() => pruefeMassnahme({ text: "ok", effekt_eur: 100 }, 0));
});

Deno.test("pruefeMassnahme: mehr als 3 offene -> Fehler", () => {
  assertThrows(() => pruefeMassnahme({ text: "Gebote senken", effekt_eur: 100 }, MAX_OFFENE));
});

Deno.test("Statuswechsel: erledigt stempelt Zeitpunkt", () => {
  const r = pruefeStatusWechsel("erledigt", null, "2026-07-30T10:00:00Z");
  assertEquals(r, { status: "erledigt", grund: null, erledigt_am: "2026-07-30T10:00:00Z" });
});

Deno.test("Statuswechsel: verworfen nur mit Grund", () => {
  assertThrows(() => pruefeStatusWechsel("verworfen", "", "2026-07-30T10:00:00Z"));
  const r = pruefeStatusWechsel("verworfen", "Kampagne läuft aus", "2026-07-30T10:00:00Z");
  assertEquals(r.grund, "Kampagne läuft aus");
  assertEquals(r.erledigt_am, null);
});

Deno.test("Statuswechsel: Wiedereröffnen räumt Grund und Zeitstempel weg", () => {
  assertEquals(pruefeStatusWechsel("offen", "alter Grund", "2026-07-30T10:00:00Z"),
    { status: "offen", grund: null, erledigt_am: null });
});

Deno.test("Statuswechsel: unbekannter Status -> Fehler", () => {
  assertThrows(() => pruefeStatusWechsel("halbfertig", null, "2026-07-30T10:00:00Z"));
});

Deno.test("summeEffekt addiert und ignoriert Unbekanntes", () => {
  assertEquals(summeEffekt([{ effekt_eur: 900 }, { effekt_eur: 120.5 }, { effekt_eur: null }]), 1020.5);
});

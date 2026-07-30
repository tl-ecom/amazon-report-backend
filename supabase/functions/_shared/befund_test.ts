import { assertEquals } from "jsr:@std/assert@1";
import {
  baueFakten, baueUserPrompt, deterministischerBefund, erlaubteZahlen,
  pruefeText, SIGNATUR, zahlenAusText,
} from "./befund.ts";

const KORR = [
  { kennzahl: "tacos", label: "TACoS", einheit: "%", min: 12, max: 20 },
  { kennzahl: "cvr", label: "Conversion Rate", einheit: "%", min: 5, max: null },
  { kennzahl: "acos", label: "ACoS", einheit: "%", min: null, max: null }, // kein Korridor
];

function fakten(ist: Record<string, number | null>, extra: Record<string, unknown> = {}) {
  return baueFakten({
    asin: "B01", produktname: "Testartikel", rolle: "scale", rolle_label: "Volumentreiber",
    stichtag: "2026-07-30", korridore: KORR, ist, ...extra,
  } as any);
}

Deno.test("baueFakten: Status je Kennzahl (ausserhalb / im Korridor / nicht bewertbar)", () => {
  const f = fakten({ tacos: 28, cvr: 12, acos: 30 });
  assertEquals(f.kennzahlen.find((k) => k.kennzahl === "tacos")!.status, "ausserhalb"); // 28 > 20
  assertEquals(f.kennzahlen.find((k) => k.kennzahl === "cvr")!.status, "im_korridor");  // 12 >= 8
  assertEquals(f.kennzahlen.find((k) => k.kennzahl === "acos")!.status, "nicht_bewertbar"); // kein Korridor
  assertEquals(f.nicht_bewertbar, ["ACoS"]);
});

Deno.test("baueFakten: unbekannter Ist-Wert -> nicht bewertbar (nie 0 erfinden)", () => {
  const f = fakten({ tacos: null, cvr: 12, acos: null });
  assertEquals(f.kennzahlen.find((k) => k.kennzahl === "tacos")!.status, "nicht_bewertbar");
  assertEquals(f.kennzahlen.find((k) => k.kennzahl === "tacos")!.ist, null);
});

Deno.test("baueFakten: ausserhalb nach EURO-Auswirkung sortiert, nicht nach Prozent", () => {
  const f = baueFakten({
    asin: "B01", produktname: "T", rolle: "scale", rolle_label: "Volumentreiber", stichtag: "2026-07-30",
    korridore: [
      { kennzahl: "tacos", label: "TACoS", einheit: "%", min: 12, max: 20 },
      { kennzahl: "cvr", label: "Conversion Rate", einheit: "%", min: 8, max: null },
    ],
    ist: { tacos: 21, cvr: 2 },            // cvr weicht prozentual viel stärker ab
    euro_monat: { tacos: 900, cvr: 100 },  // aber TACoS kostet mehr Geld
  });
  assertEquals(f.ausserhalb.map((k) => k.kennzahl), ["tacos", "cvr"]);
});

Deno.test("baueFakten: auffaellig-ruhig erkennt Statuswechsel in beide Richtungen", () => {
  const f = fakten({ tacos: 15, cvr: 3 }, { vorher: { tacos: "ausserhalb", cvr: "im_korridor" } });
  const texte = f.ruhig.map((r) => r.text);
  assertEquals(texte.includes("TACoS ist zurück im Korridor."), true);
  assertEquals(texte.includes("Conversion Rate hat den Korridor neu verlassen."), true);
});

Deno.test("zahlenAusText: deutsches Format (Tausenderpunkt, Dezimalkomma)", () => {
  assertEquals(zahlenAusText("TACoS 28,5 % über 20 %; 1.234,50 € pro Monat"), [28.5, 20, 1234.5]);
});

Deno.test("Guardrail: Text nur mit belegten Zahlen -> ok", () => {
  const f = fakten({ tacos: 28, cvr: 12 }, { euro_monat: { tacos: 840 } });
  const text = `Volumentreiber unter Druck.\nTACoS: 28 % über Korridor (20 %). Auswirkung: 840 € pro Monat.\n${SIGNATUR}`;
  assertEquals(pruefeText(text, f).ok, true);
});

Deno.test("Guardrail: erfundene Zahl -> verworfen, wird benannt", () => {
  const f = fakten({ tacos: 28, cvr: 12 }, { euro_monat: { tacos: 840 } });
  const text = `TACoS: 28 % über Korridor (20 %). Das kostet rund 1.500 € pro Monat.\n${SIGNATUR}`;
  const r = pruefeText(text, f);
  assertEquals(r.ok, false);
  assertEquals(r.unbelegt, [1500]);
});

Deno.test("Guardrail: selbst gerechnete Differenz ist unbelegt", () => {
  const f = fakten({ tacos: 28, cvr: 12 });
  // 28 - 20 = 8 steht NICHT in den Fakten -> muss auffallen.
  const r = pruefeText(`TACoS liegt 8 Punkte über der Obergrenze.`, f);
  assertEquals(r.ok, false);
  assertEquals(r.unbelegt, [8]);
});

Deno.test("Guardrail: Stichtags-Bestandteile und 0 sind zugelassen", () => {
  const f = fakten({ tacos: 15, cvr: 12 });
  assertEquals(pruefeText("Stand 2026-07-30. 0 Kennzahlen außerhalb.", f).ok, true);
});

Deno.test("erlaubteZahlen enthält Ist, Grenzen und Euro-Werte", () => {
  const f = fakten({ tacos: 28, cvr: 12 }, { euro_monat: { tacos: 840 } });
  const s = erlaubteZahlen(f);
  for (const n of [28, 12, 20, 5, 840]) assertEquals(s.has(n), true);
});

Deno.test("deterministischerBefund: nennt Ist, Grenze, Euro und signiert", () => {
  const f = fakten({ tacos: 28, cvr: 12 }, { euro_monat: { tacos: 840 } });
  const b = deterministischerBefund(f);
  assertEquals(b.diagnose.includes("Volumentreiber"), true);
  assertEquals(b.text.includes("28 %"), true);
  assertEquals(b.text.includes("840"), true);
  assertEquals(b.text.trim().endsWith(SIGNATUR), true);
  // Der Fallback muss seinen eigenen Guardrail bestehen.
  assertEquals(pruefeText(b.text, f).ok, true);
});

Deno.test("deterministischerBefund: alles im Korridor -> ruhige Diagnose, besteht Guardrail", () => {
  const f = fakten({ tacos: 15, cvr: 12 });
  const b = deterministischerBefund(f);
  assertEquals(b.diagnose.includes("im Korridor"), true);
  assertEquals(pruefeText(b.text, f).ok, true);
});

Deno.test("baueUserPrompt liefert gültiges JSON mit den Fakten", () => {
  const f = fakten({ tacos: 28, cvr: 12 }, { euro_monat: { tacos: 840 } });
  const p = JSON.parse(baueUserPrompt(f));
  assertEquals(p.rolle, "Volumentreiber");
  assertEquals(p.ausserhalb[0].kennzahl, "TACoS");
  assertEquals(p.ausserhalb[0].euro_pro_monat, 840);
});

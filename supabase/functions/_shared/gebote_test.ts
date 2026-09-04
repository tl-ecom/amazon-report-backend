// Tests für gebote.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import { baueAenderungen, fasseZusammen, MIN_GEBOT, neuesGebot, pruefeRegel, targetText, type GebotsZeile } from "./gebote.ts";

function kw(id: string, gebot: number, extra: Partial<GebotsZeile> = {}): GebotsZeile {
  return { art: "keyword", id, campaignId: "C1", adGroupId: "AG1", text: `kw ${id}`, matchType: "BROAD", state: "ENABLED", gebot, ...extra };
}

Deno.test("pruefeRegel: genau eine Angabe", () => {
  assertEquals(pruefeRegel({}), "Genau eine Angabe von prozent, faktor oder absolut.");
  assertEquals(pruefeRegel({ prozent: -20, faktor: 0.8 }), "Genau eine Angabe von prozent, faktor oder absolut.");
  assertEquals(pruefeRegel({ prozent: -20 }), null);
  assertEquals(pruefeRegel({ faktor: 0.8 }), null);
  assertEquals(pruefeRegel({ absolut: 0.5 }), null);
});

Deno.test("pruefeRegel: Grenzen", () => {
  assertEquals(pruefeRegel({ prozent: -100 }), "prozent muss > -100 sein.");
  assertEquals(pruefeRegel({ faktor: 0 }), "faktor muss > 0 sein.");
  assertEquals(pruefeRegel({ absolut: 0.01 }), `absolut muss >= ${MIN_GEBOT} sein.`);
  assertEquals(pruefeRegel({ prozent: -10, min: 0.5, max: 0.4 }), "min darf nicht über max liegen.");
});

Deno.test("neuesGebot: prozent, faktor, absolut", () => {
  assertEquals(neuesGebot(1.0, { prozent: -20 }), 0.8);
  assertEquals(neuesGebot(1.0, { prozent: 10 }), 1.1);
  assertEquals(neuesGebot(0.75, { faktor: 0.5 }), 0.38); // 0.375 -> kaufmännisch 0.38
  assertEquals(neuesGebot(1.0, { absolut: 0.33 }), 0.33);
});

Deno.test("neuesGebot: Untergrenze und Kappung", () => {
  assertEquals(neuesGebot(0.03, { prozent: -90 }), MIN_GEBOT);   // 0.003 -> 0.02
  assertEquals(neuesGebot(0.30, { prozent: -50, min: 0.25 }), 0.25);
  assertEquals(neuesGebot(1.00, { prozent: 50, max: 1.2 }), 1.2);
});

Deno.test("baueAenderungen: unveränderte Zeilen fallen weg", () => {
  const zeilen = [kw("a", 1.0), kw("b", MIN_GEBOT), kw("c", 0.5, { art: "target", text: "asinSameAs=B0X" })];
  const aend = baueAenderungen(zeilen, { prozent: -20 });
  // b bleibt auf der Untergrenze -> keine Änderung -> raus
  assertEquals(aend.map((a) => a.id), ["a", "c"]);
  assertEquals(aend[0].neu, 0.8);
  assertEquals(aend[0].delta, -0.2);
  assertEquals(aend[1].neu, 0.4);
  const z = fasseZusammen(aend);
  assertEquals(z, { anzahl: 2, keywords: 1, targets: 1, summe_alt: 1.5, summe_neu: 1.2 });
});

Deno.test("baueAenderungen: kaputte Gebote werden übersprungen", () => {
  const aend = baueAenderungen([kw("a", NaN), kw("b", 1.0)], { faktor: 0.5 });
  assertEquals(aend.map((a) => a.id), ["b"]);
});

Deno.test("targetText", () => {
  assertEquals(targetText([{ type: "asinSameAs", value: "B0XYZ" }]), "asinSameAs=B0XYZ");
  assertEquals(targetText([{ type: "queryBroadRelMatches" }]), "queryBroadRelMatches");
  assertEquals(targetText(undefined), "");
});

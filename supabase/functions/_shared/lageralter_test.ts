import { assertEquals } from "jsr:@std/assert@1";
import { teileLagergebuehr, type Altersstufen } from "./lageralter.ts";

function stufen(over: Partial<Altersstufen> = {}): Altersstufen {
  return {
    alter_0_30: 0, alter_31_60: 0, alter_61_90: 0,
    alter_91_180: 0, alter_181_270: 0, alter_271_365: 0, alter_365_plus: 0,
    ...over,
  };
}

Deno.test("teileLagergebuehr: erste drei Monate sind nicht steuerbar", () => {
  const a = teileLagergebuehr(10000, stufen({ alter_0_30: 50, alter_31_60: 30, alter_61_90: 20 }));
  assertEquals(a.alt_cents, 0);
  assertEquals(a.frisch_cents, 10000);
  assertEquals(a.anteil_alt, 0);
  assertEquals(a.geschaetzt, false);
});

Deno.test("teileLagergebuehr: ab Monat 4 wird der Mengenanteil zugerechnet", () => {
  // 30 von 100 Einheiten liegen laenger als drei Monate -> 30 % der Gebuehr.
  const a = teileLagergebuehr(10000, stufen({
    alter_0_30: 40, alter_61_90: 30, alter_91_180: 20, alter_365_plus: 10,
  }));
  assertEquals(a.anteil_alt, 0.3);
  assertEquals(a.alt_cents, 3000);
  assertEquals(a.frisch_cents, 7000);
  assertEquals(a.menge_alt, 30);
});

Deno.test("teileLagergebuehr: die 90-Tage-Grenze liegt zwischen 61-90 und 91-180", () => {
  const gerade_noch = teileLagergebuehr(1000, stufen({ alter_61_90: 10 }));
  assertEquals(gerade_noch.alt_cents, 0);
  const knapp_darueber = teileLagergebuehr(1000, stufen({ alter_91_180: 10 }));
  assertEquals(knapp_darueber.alt_cents, 1000);
});

Deno.test("teileLagergebuehr: unbekanntes Alter -> alles frisch, als Schaetzung markiert", () => {
  // Vorsichtige Richtung: dem Verkaeufer nichts zuschreiben, was nicht belegt ist.
  const ohne = teileLagergebuehr(10000, null);
  assertEquals(ohne.alt_cents, 0);
  assertEquals(ohne.frisch_cents, 10000);
  assertEquals(ohne.geschaetzt, true);
  assertEquals(ohne.anteil_alt, null);

  const leer = teileLagergebuehr(10000, stufen());
  assertEquals(leer.geschaetzt, true);
  assertEquals(leer.alt_cents, 0);
});

Deno.test("teileLagergebuehr: Rundung verliert keinen Cent", () => {
  const a = teileLagergebuehr(10001, stufen({ alter_0_30: 1, alter_91_180: 2 }));
  assertEquals(a.frisch_cents + a.alt_cents, 10001);
});

Deno.test("teileLagergebuehr: unsinnige Mengen werden ignoriert, nicht mitgerechnet", () => {
  const a = teileLagergebuehr(1000, stufen({
    alter_0_30: -5, alter_91_180: 10, alter_365_plus: null as any,
  }));
  assertEquals(a.menge_frisch, 0);
  assertEquals(a.menge_alt, 10);
  assertEquals(a.alt_cents, 1000);
});

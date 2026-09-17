// Tests für gebotsautomatik.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  berechneVorschlag,
  berechneVorschlaege,
  bilanz,
  geschaetzteCvr,
  gewichteterAufschlag,
  klemme,
  PRIOR_KLICKS,
  umsatzJeBestellung,
  type GruppenLeistung,
  type Regel,
  type ZielLeistung,
} from "./gebotsautomatik.ts";

const REGEL: Regel = {
  campaign_id: "C1",
  ziel_acos: 0.30,
  min_gebot: 0.30,
  max_gebot: 1.25,
  max_schritt_prozent: 15,
  min_klicks: 8,
};

function ziel(extra: Partial<ZielLeistung> = {}): ZielLeistung {
  return {
    art: "keyword", ziel_id: "Z1", campaign_id: "C1", ad_group_id: "AG1",
    text: "kratzbrett katze", match_type: "EXACT", state: "ENABLED",
    gebot: 1.00, klicks: 20, bestellungen: 3, umsatz: 60,
    ...extra,
  };
}

const gruppe = (extra: Partial<GruppenLeistung> = {}): GruppenLeistung => ({
  ad_group_id: "AG1", klicks: 200, bestellungen: 30, umsatz: 600, ...extra,
});

// ------------------------------------------------------------ Aufschlag

Deno.test("gewichteterAufschlag: nach Klicks gewichtet, nicht gleichverteilt", () => {
  // 80 % der Klicks auf Top of Search mit +50 %, 20 % auf Produktseite mit 0 %.
  const a = gewichteterAufschlag([
    { platzierung: "Top of Search", klicks: 80, modifikator: 0.5 },
    { platzierung: "Produktseite", klicks: 20, modifikator: 0 },
  ]);
  assertAlmostEquals(a, 0.4, 1e-9);
});

Deno.test("gewichteterAufschlag: ohne Klicks konservativ 0", () => {
  assertEquals(gewichteterAufschlag([]), 0);
  assertEquals(gewichteterAufschlag([{ platzierung: "Top of Search", klicks: 0, modifikator: 0.7 }]), 0);
});

// ------------------------------------------------------------ CVR-Schätzung

Deno.test("geschaetzteCvr: ohne eigene Klicks gilt die Gruppe", () => {
  const c = geschaetzteCvr({ klicks: 0, bestellungen: 0 }, { klicks: 200, bestellungen: 30 });
  assertEquals(c.eigen, null);
  assertAlmostEquals(c.gruppe!, 0.15, 1e-9);
  assertAlmostEquals(c.genutzt!, 0.15, 1e-9);
});

Deno.test("geschaetzteCvr: bei Prior-Stärke halb eigen, halb Gruppe", () => {
  // Ziel: PRIOR_KLICKS Klicks, 0 Bestellungen. Gruppe: 15 %.
  const c = geschaetzteCvr(
    { klicks: PRIOR_KLICKS, bestellungen: 0 },
    { klicks: 200, bestellungen: 30 },
  );
  assertAlmostEquals(c.genutzt!, 0.075, 1e-9);
});

Deno.test("geschaetzteCvr: viele eigene Daten überstimmen die Gruppe", () => {
  const c = geschaetzteCvr(
    { klicks: 1000, bestellungen: 300 },   // 30 % eigen
    { klicks: 2000, bestellungen: 300 },   // 15 % Gruppe
  );
  // Muss deutlich näher an 30 % als an 15 % liegen.
  assertEquals(c.genutzt! > 0.29, true);
});

Deno.test("geschaetzteCvr: ein einzelner Klick mit Bestellung kippt nichts", () => {
  // Ohne Shrinkage wäre das 100 % CVR — genau der Fehler, den wir vermeiden.
  const c = geschaetzteCvr({ klicks: 1, bestellungen: 1 }, { klicks: 200, bestellungen: 30 });
  assertEquals(c.eigen, 1);
  assertEquals(c.genutzt! < 0.25, true);
});

// ------------------------------------------------------------ Umsatz je Bestellung

Deno.test("umsatzJeBestellung: Gruppe schlägt Ziel", () => {
  // Ziel hätte 40 EUR (Mehrstück-Kauf), Gruppe 20 EUR — die Gruppe gewinnt.
  const u = umsatzJeBestellung({ bestellungen: 1, umsatz: 40 }, { bestellungen: 30, umsatz: 600 });
  assertEquals(u, 20);
});

Deno.test("umsatzJeBestellung: ohne Gruppendaten das Ziel, sonst null", () => {
  assertEquals(umsatzJeBestellung({ bestellungen: 2, umsatz: 40 }, { bestellungen: 0, umsatz: 0 }), 20);
  assertEquals(umsatzJeBestellung({ bestellungen: 0, umsatz: 0 }, { bestellungen: 0, umsatz: 0 }), null);
});

// ------------------------------------------------------------ Klammer

Deno.test("klemme: Schrittweite begrenzt den Sprung", () => {
  const r = klemme(1.00, 0.50, REGEL);
  assertEquals(r.wert, 0.85);
  assertEquals(r.gekappt, "Schrittweite 15 %");
});

Deno.test("klemme: Obergrenze sticht", () => {
  const r = klemme(1.20, 2.00, { ...REGEL, max_schritt_prozent: 100 });
  assertEquals(r.wert, 1.25);
  assertEquals(r.gekappt, "Obergrenze 1.25 EUR");
});

Deno.test("klemme: Regel-Untergrenze sticht", () => {
  const r = klemme(0.40, 0.05, { ...REGEL, max_schritt_prozent: 100 });
  assertEquals(r.wert, 0.30); // min_gebot der Regel
  assertEquals(r.gekappt, "Untergrenze 0.30 EUR");
});

Deno.test("klemme: Amazons Minimum gilt auch gegen eine zu niedrige Regel", () => {
  // Regel erlaubt 0,01 — Amazon lehnt das mit 422 ab, also 0,02.
  const r = klemme(0.40, 0.005, { ...REGEL, max_schritt_prozent: 100, min_gebot: 0.01 });
  assertEquals(r.wert, 0.02);
});

// ------------------------------------------------------------ Vorschlag

Deno.test("berechneVorschlag: rechnet den Aufschlag heraus", () => {
  // Umsatz/Bestellung 20, Ziel-ACoS 30 %, CVR genutzt ~15,2 % -> Max-CPC ~0,91.
  // Bei 50 % Aufschlag ist das tragfähige Basisgebot ~0,61 statt 0,91.
  const v = berechneVorschlag(ziel({ gebot: 1.00 }), gruppe(), 0.5, { ...REGEL, max_schritt_prozent: 100 });
  assertEquals(v.aktion, "senken");
  assertEquals(v.gebot_neu! < v.max_cpc!, true);
  assertAlmostEquals(v.gebot_neu!, v.max_cpc! / 1.5, 0.01);
});

Deno.test("berechneVorschlag: ohne Aufschlag ist Zielgebot der Max-CPC", () => {
  const v = berechneVorschlag(ziel({ gebot: 1.00 }), gruppe(), 0, { ...REGEL, max_schritt_prozent: 100 });
  assertAlmostEquals(v.gebot_neu!, v.max_cpc!, 0.01);
});

Deno.test("berechneVorschlag: Ziel ohne Klicks wird NICHT angehoben", () => {
  // Der Fehler von Helium 10: Gebot hoch auf einem Ziel ohne jede Klickhistorie.
  // Hier liefert die Gruppen-CVR einen Max-CPC, der unter dem Altgebot liegt.
  const v = berechneVorschlag(
    ziel({ gebot: 1.00, klicks: 0, bestellungen: 0, umsatz: 0 }),
    gruppe(), 0.5, REGEL,
  );
  assertEquals(v.aktion, "senken");
  assertEquals(v.belastbar, false);
});

Deno.test("berechneVorschlag: ohne jede Bestellung in Ziel und Gruppe passiert nichts", () => {
  const v = berechneVorschlag(
    ziel({ gebot: 1.00, klicks: 4, bestellungen: 0, umsatz: 0 }),
    gruppe({ klicks: 30, bestellungen: 0, umsatz: 0 }),
    0.3, REGEL,
  );
  assertEquals(v.aktion, "keine_daten");
  assertEquals(v.gebot_neu, null);
});

Deno.test("berechneVorschlag: geerbtes Gebot bleibt unangetastet", () => {
  const v = berechneVorschlag(ziel({ gebot: null }), gruppe(), 0, REGEL);
  assertEquals(v.aktion, "erbt_gruppengebot");
  assertEquals(v.gebot_neu, null);
});

Deno.test("berechneVorschlag: pausierte Ziele werden übersprungen", () => {
  const v = berechneVorschlag(ziel({ state: "PAUSED" }), gruppe(), 0, REGEL);
  assertEquals(v.aktion, "nicht_aktiv");
  assertEquals(v.gebot_neu, null);
});

Deno.test("berechneVorschlag: Totzone verhindert Cent-Vorschläge", () => {
  // Gebot so wählen, dass es fast exakt dem Zielgebot entspricht.
  const vorlauf = berechneVorschlag(ziel({ gebot: 1.00 }), gruppe(), 0, { ...REGEL, max_schritt_prozent: 100 });
  const treffer = vorlauf.gebot_neu!;
  const v = berechneVorschlag(ziel({ gebot: treffer + 0.01 }), gruppe(), 0, REGEL);
  assertEquals(v.aktion, "unveraendert");
  assertEquals(v.gebot_neu, null);
});

Deno.test("berechneVorschlag: Begründung nennt den Rechenweg", () => {
  const v = berechneVorschlag(ziel({ gebot: 1.00 }), gruppe(), 0.5, REGEL);
  assertEquals(v.begruendung.includes("Max-CPC"), true);
  assertEquals(v.begruendung.includes("Ziel-ACoS"), true);
  assertEquals(v.begruendung.includes("Platzierungs-Aufschlag 50 %"), true);
});

// ------------------------------------------------------------ Lauf

Deno.test("berechneVorschlaege: filtert auf die Kampagne der Regel", () => {
  const ziele = [ziel({ ziel_id: "A" }), ziel({ ziel_id: "B", campaign_id: "C2" })];
  const v = berechneVorschlaege(ziele, [gruppe()], [], REGEL);
  assertEquals(v.length, 1);
  assertEquals(v[0].ziel_id, "A");
});

Deno.test("bilanz: zählt die Aktionen", () => {
  const v = berechneVorschlaege(
    [
      ziel({ ziel_id: "A", gebot: 1.00 }),
      ziel({ ziel_id: "B", gebot: null }),
      ziel({ ziel_id: "C", state: "PAUSED" }),
    ],
    [gruppe()], [], REGEL,
  );
  const b = bilanz(v);
  assertEquals(b.gesamt, 3);
  assertEquals(b.erbt_gruppengebot, 1);
  assertEquals(b.nicht_aktiv, 1);
});

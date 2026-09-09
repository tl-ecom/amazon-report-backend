import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bereinigteVelocity, fuehreParameterZusammen, konstant, leerTageAusVerlauf, planeAsin,
  STANDARD_PARAMETER, tagDiff, tagPlus, vorjahrKurve, vorjahrTag, wochenstart, zaehleLeerTage,
  type PlanEingabe,
} from "./bestandsplanung.ts";

const HEUTE = "2026-09-10";

function eingabe(over: Partial<PlanEingabe> = {}): PlanEingabe {
  return {
    heute: HEUTE, bestand: 100, bestand_bekannt: true, lager_bestand: null, zulaeufe: [],
    velocity: konstant(2), parameter: { ...STANDARD_PARAMETER }, horizont_tage: 180, ...over,
  };
}

// --- Datumshelfer ---

Deno.test("wochenstart liefert den Montag (date_trunc week)", () => {
  assertEquals(wochenstart("2026-09-10"), "2026-09-07"); // Donnerstag -> Montag
  assertEquals(wochenstart("2026-09-07"), "2026-09-07");
  assertEquals(wochenstart("2026-09-13"), "2026-09-07"); // Sonntag gehoert noch zur Woche
});

Deno.test("vorjahrTag: derselbe Kalendertag, 29.02. wird 01.03.", () => {
  assertEquals(vorjahrTag("2026-09-10"), "2025-09-10");
  assertEquals(vorjahrTag("2028-02-29"), "2027-03-01");
});

Deno.test("tagPlus/tagDiff sind Umkehrungen", () => {
  assertEquals(tagDiff(HEUTE, tagPlus(HEUTE, 37)), 37);
  assertEquals(tagDiff(HEUTE, tagPlus(HEUTE, -5)), -5);
});

// --- Bereinigte Geschwindigkeit ---

Deno.test("bereinigt: Einheiten durch Tage MIT Bestand", () => {
  const v = bereinigteVelocity(30, 30, 10);
  assertEquals(v.velo, 1.5);
  assertEquals(v.messtage, 20);
  assertEquals(v.bereinigt, true);
  assertEquals(v.unsicher, false);
});

Deno.test("ohne Ledger: ganzes Fenster, als unbereinigt gekennzeichnet", () => {
  const v = bereinigteVelocity(30, 30, null);
  assertEquals(v.velo, 1);
  assertEquals(v.bereinigt, false);
});

Deno.test("fast nur Leertage: Nenner bleibt bei MIN_MESSTAGE, unsicher", () => {
  const v = bereinigteVelocity(30, 30, 28);
  assertEquals(v.messtage, 2);
  assertEquals(v.unsicher, true);
  assertEquals(v.velo, 30 / 7); // nicht 15/Tag aus zwei Tagen hochgerechnet
});

// --- Vorjahres-Kurve ---

Deno.test("Vorjahres-Kurve: Wochenabsatz durch Tage mit Bestand, fehlende Woche = 0, davor Rueckfall", () => {
  // heute+0 = 2026-09-10 -> Vorjahr 2025-09-10 -> Woche ab Montag 2025-09-08.
  const wochen = new Map([["2025-09-08", 14]]);
  const k = vorjahrKurve({ heute: HEUTE, wochen, abdeckung_von: "2025-09-01", faktor: null, rueckfall: 0.5 });
  assertEquals(k.velocity(0), 2);
  // heute+7 -> 2025-09-17 -> Woche 2025-09-15: innerhalb der Abdeckung, kein Verkauf -> 0.
  assertEquals(k.velocity(7), 0);
  // Abdeckung beginnt erst nach beiden Wochen -> unbekannt -> Rueckfall.
  const k2 = vorjahrKurve({ heute: HEUTE, wochen, abdeckung_von: "2025-09-22", faktor: null, rueckfall: 0.5 });
  assertEquals(k2.velocity(0), 0.5);
  assertEquals(k2.abdeckung(7), 0);
  assertEquals(k.abdeckung(7), 1);
});

Deno.test("Vorjahres-Kurve: Faktor skaliert, ganze Woche leer -> Rueckfall", () => {
  const wochen = new Map([["2025-09-08", 14]]);
  const k = vorjahrKurve({ heute: HEUTE, wochen, abdeckung_von: "2025-09-01", faktor: 1.5, rueckfall: 0.5 });
  assertEquals(k.velocity(0), 3);
  const leer = new Map([["2025-09-08", 7]]);
  const k2 = vorjahrKurve({ heute: HEUTE, wochen, leerTageJeWoche: leer, abdeckung_von: "2025-09-01", faktor: null, rueckfall: 0.5 });
  assertEquals(k2.velocity(0), 0.5);
  // 3 Leertage in der Woche: 14 Einheiten auf 4 Tage mit Bestand.
  const k3 = vorjahrKurve({ heute: HEUTE, wochen, leerTageJeWoche: new Map([["2025-09-08", 3]]), abdeckung_von: "2025-09-01", faktor: null, rueckfall: 0.5 });
  assertEquals(k3.velocity(0), 3.5);
});

// --- Planung ---

Deno.test("ohne Lagerdatensatz keine Planung: unbekannt", () => {
  const p = planeAsin(eingabe({ bestand: null, bestand_bekannt: false }));
  assertEquals(p.status, "unbekannt");
  assertEquals(p.bestellmenge, 0);
  assertEquals(p.projektion.length, 0);
});

Deno.test("Bestand da, aber kein Absatz -> kein_absatz, Reichweite unbekannt", () => {
  const p = planeAsin(eingabe({ bestand: 50, velocity: konstant(0) }));
  assertEquals(p.status, "kein_absatz");
  assertEquals(p.reichweite_tage, null);
  assertEquals(p.leer_am, null);
});

Deno.test("100 Stueck bei 2/Tag: leer nach 50 Tagen, Bestelltermin liegt hinter uns", () => {
  const p = planeAsin(eingabe());
  assertEquals(p.reichweite_tage, 50);
  assertEquals(p.leer_am, tagPlus(HEUTE, 49)); // am Ende des 50. Tages leer
  // Rueckwaerts: leer − (30 + 30) − 28
  assertEquals(p.bestellpunkt_am, tagPlus(p.leer_am!, -88));
  assertEquals(p.bestellen_bis_tage, 49 - 88);
  assertEquals(p.status, "ueberfaellig");
  // Bestellt man heute, kommt die Ware in 60 Tagen — das Lager ist dann leer,
  // also braucht es den vollen Absatz der Zielreichweite: 90 Tage x 2.
  assertEquals(p.ankunft_am, tagPlus(HEUTE, 60));
  assertEquals(p.bedarf_einheiten, 180);
  assertEquals(p.bestellmenge, 180);
  assertEquals(p.projektion.length, 181);
  assertEquals(p.projektion[0].bestand, 98);
  assertEquals(p.projektion[60].bestand, 0);
});

Deno.test("eigenes Lager mindert die Bestellmenge, nicht den Bedarf", () => {
  const p = planeAsin(eingabe({ lager_bestand: 50 }));
  assertEquals(p.bedarf_einheiten, 180);
  assertEquals(p.bestellmenge, 130);
});

Deno.test("300 Stueck bei 2/Tag: Termin in 62 Tagen -> ok; Bedarf beruecksichtigt Restbestand bei Ankunft", () => {
  const p = planeAsin(eingabe({ bestand: 300 }));
  assertEquals(p.leer_am, tagPlus(HEUTE, 149));
  assertEquals(p.bestellen_bis_tage, 149 - 88);
  assertEquals(p.status, "ok");
  // Ankunft am Tag 61 + 60 = 121 nach heute; Restbestand am Vorabend: 300 − 2·121 = 58.
  assertEquals(p.ankunft_am, tagPlus(HEUTE, 121));
  assertEquals(p.bedarf_einheiten, 180 - 58);
});

Deno.test("Termin innerhalb 7 Tagen -> jetzt, innerhalb 30 -> bald", () => {
  // leer nach 100 Tagen; Bestellpunkt 99 − 88 = 11 -> bald
  const bald = planeAsin(eingabe({ bestand: 100, velocity: konstant(1) }));
  assertEquals(bald.bestellen_bis_tage, 11);
  assertEquals(bald.status, "bald");
  // Mindest-Reichweite 35: 99 − 95 = 4 -> jetzt
  const jetzt = planeAsin(eingabe({ bestand: 100, velocity: konstant(1), parameter: { ...STANDARD_PARAMETER, min_reichweite_tage: 35 } }));
  assertEquals(jetzt.bestellen_bis_tage, 4);
  assertEquals(jetzt.status, "jetzt");
});

Deno.test("mehr als das Doppelte der Zielreichweite -> Ueberbestand", () => {
  const p = planeAsin(eingabe({ bestand: 1000 }));
  assertEquals(p.reichweite_tage, 500);
  assertEquals(p.status, "ueberbestand");
});

Deno.test("leer, Ware in 14 Tagen unterwegs: Status leer, Planung zielt auf die Luecke NACH der Ankunft", () => {
  const p = planeAsin(eingabe({
    bestand: 0, zulaeufe: [{ datum: tagPlus(HEUTE, 14), menge: 100, art: "amazon" }],
  }));
  assertEquals(p.status, "leer");
  assertEquals(p.reichweite_tage, 0);
  assertEquals(p.reichweite_ohne_zulauf_tage, 0);
  assertEquals(p.leer_am, HEUTE);
  // Ab Tag 14: 100 Stueck, 2/Tag -> am Ende von Tag 63 leer.
  assertEquals(p.planungs_leer_am, tagPlus(HEUTE, 63));
  assertEquals(p.bestellpunkt_am, tagPlus(HEUTE, 63 - 88));
  assertEquals(p.projektion[14].bestand, 98);
  assertEquals(p.projektion[14].zulauf, 100);
});

Deno.test("leer und nichts kommt: die Luecke ist heute, Termin ueberfaellig", () => {
  const p = planeAsin(eingabe({ bestand: 0 }));
  assertEquals(p.status, "leer");
  assertEquals(p.planungs_leer_am, HEUTE);
  assertEquals(p.bestellen_bis_tage, -88);
  assertEquals(p.bedarf_einheiten, 180);
});

Deno.test("Zulauf mit Datum in der Vergangenheit trifft heute ein, nicht nie", () => {
  const p = planeAsin(eingabe({
    bestand: 10, zulaeufe: [{ datum: tagPlus(HEUTE, -3), menge: 90, art: "bestellung" }],
  }));
  assertEquals(p.projektion[0].zulauf, 90);
  assertEquals(p.reichweite_tage, 50);
});

Deno.test("Bestellung im Fenster mindert den Bedarf", () => {
  // 100 Stueck, 2/Tag, Bestellung 100 Stueck kommt am Tag 70 (im Zielfenster ab Tag 60).
  const p = planeAsin(eingabe({
    zulaeufe: [{ datum: tagPlus(HEUTE, 70), menge: 100, art: "bestellung" }],
  }));
  assertEquals(p.ankunft_am, tagPlus(HEUTE, 60));
  assertEquals(p.bedarf_einheiten, 80);
});

Deno.test("Zeitachse laeuft mit der Vorjahres-Kurve, nicht mit einer Konstante", () => {
  // Tag 0..6: 4/Tag, danach 1/Tag.
  const velocity = (i: number) => (i < 7 ? 4 : 1);
  const p = planeAsin(eingabe({ bestand: 50, velocity }));
  assertEquals(p.projektion[6].bestand, 50 - 28);
  assertEquals(p.projektion[7].bestand, 50 - 29);
  // leer: 22 Stueck nach Tag 6, 1/Tag -> Ende von Tag 28.
  assertEquals(p.leer_am, tagPlus(HEUTE, 28));
});

// --- Leertage & Parameter ---

Deno.test("Leertage aus dem Verlauf: fortgeschriebene Luecken zaehlen mit", () => {
  const leer = leerTageAusVerlauf([
    { datum: "2026-09-01", menge: 5, verkauft: 1 },
    { datum: "2026-09-02", menge: 0, verkauft: 0 },
    // 03. fehlt (keine Bewegung) -> bleibt 0
    { datum: "2026-09-04", menge: 0, verkauft: 0 },
    { datum: "2026-09-05", menge: 20, verkauft: 2 },
  ]);
  assertEquals([...leer].sort(), ["2026-09-02", "2026-09-03", "2026-09-04"]);
  assertEquals(zaehleLeerTage(leer, "2026-09-03", "2026-09-06"), 2);
});

Deno.test("Parameter: Produkt vor Firma vor Standard, Herkunft je Feld", () => {
  const p = fuehreParameterZusammen(
    { lieferzeit_tage: 45, transit_tage: null },
    { lieferzeit_tage: 20, transit_tage: 40, min_reichweite_tage: null, max_reichweite_tage: null },
  );
  assertEquals(p.lieferzeit_tage, 45);
  assertEquals(p.quelle.lieferzeit_tage, "produkt");
  assertEquals(p.transit_tage, 40);
  assertEquals(p.quelle.transit_tage, "firma");
  assertEquals(p.min_reichweite_tage, STANDARD_PARAMETER.min_reichweite_tage);
  assertEquals(p.quelle.min_reichweite_tage, "standard");
  assert(p.max_reichweite_tage > 0);
});

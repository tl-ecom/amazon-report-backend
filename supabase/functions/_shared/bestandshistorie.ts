// bestandshistorie.ts — ECHTE Out-of-Stock-Zeiträume mit Anfang, Ende und Dauer.
//
// Quelle: der Ledger-SUMMARY-Report (GET_LEDGER_SUMMARY_VIEW_DATA, DAILY) in
// `fba_bestand_verlauf`. Dessen `Ending Warehouse Balance` ist der GEMESSENE
// Lagerstand am Ende jedes Tages — damit ist ein Ausverkauf keine Vermutung mehr.
//
// Abgrenzung zum Nachschub-Radar (#4): der schließt aus abbrechenden Verkäufen
// und Buy-Box-Verlust auf einen wahrscheinlich leeren Bestand und beantwortet
// „was ist JETZT?". Dieses Modul misst und beantwortet „was WAR?" — wie oft, wie
// lange und wann ein Produkt tatsächlich nicht lieferbar war.
//
// EHRLICHKEITSREGELN (die hier nicht brechen dürfen):
//  * Es wird NUR innerhalb des abgedeckten Zeitraums geurteilt (erster bis letzter
//    Tag mit Messwert je Produkt). Vor dem ersten und nach dem letzten Messwert
//    wird nichts behauptet.
//  * Tage OHNE Zeile werden mit dem letzten gemessenen Endbestand fortgeschrieben,
//    nicht auf 0 gesetzt. Der Ledger ist ein Bestandskonto: ohne Bewegung bleibt
//    der Endbestand stehen. Diese Richtung ist die vorsichtige — sie kann eine
//    Leerphase verkürzen, aber niemals eine erfinden. Fortgeschriebene Tage werden
//    je Phase und gesamt ausgewiesen (`luecken_tage`).
//  * Eine Phase, die am letzten Messtag noch offen ist, bekommt `bis: null` und
//    `laufend: true` — „mindestens X Tage", keine Hochrechnung in die Zukunft.
//  * Entgangene Einheiten sind eine SCHÄTZUNG aus der eigenen Verkaufsgeschwindigkeit
//    (nur an Tagen MIT Bestand gemessen). Ohne solche Tage: null, nicht 0.

/** Ein gemessener Tag je Produkt: Endbestand und verkaufte Einheiten. */
export interface TagesStand {
  datum: string;   // YYYY-MM-DD
  menge: number;   // verkaufsfähiger Endbestand (über Orte summiert)
  verkauft?: number; // Customer Shipments des Tages, positiv
}

export interface Leerphase {
  von: string;
  /** null = am letzten Messtag noch leer (laufend). */
  bis: string | null;
  /** Kalendertage inklusive Anfang und (bekanntem) Ende. Bei `laufend` = bisher. */
  tage: number;
  laufend: boolean;
  /** Tage der Phase ohne eigene Report-Zeile (fortgeschrieben). */
  luecken_tage: number;
  /** velo_tag × tage, gerundet. null = keine Verkaufsgeschwindigkeit messbar. */
  entgangene_einheiten: number | null;
}

export interface ProduktHistorie {
  abdeckung_von: string;
  abdeckung_bis: string;
  abdeckung_tage: number;
  gemessene_tage: number;
  luecken_tage: number;
  phasen: Leerphase[];
  tage_leer: number;
  /** Anteil der leeren Tage am abgedeckten Zeitraum, 0..1. */
  anteil_leer: number;
  laengste_phase_tage: number;
  /** Am letzten Messtag leer. */
  aktuell_leer: boolean;
  letzter_stand: number;
  /** Ø verkaufte Einheiten je Tag MIT Bestand. null = nicht messbar. */
  velo_tag: number | null;
  entgangene_einheiten: number | null;
}

const TAG_MS = 86_400_000;

function tagPlus(datum: string, n: number): string {
  return new Date(Date.parse(datum + "T00:00:00Z") + n * TAG_MS).toISOString().slice(0, 10);
}

/** Kalendertage von a bis b inklusive (b >= a). */
export function tageZwischen(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / TAG_MS) + 1;
}

/**
 * Leerphasen EINES Produkts aus seinen Tagesständen. Rein, ohne Datenbank.
 *
 * `mindest_tage` blendet nur die Ausgabe kürzerer Phasen aus (z.B. eintägige
 * Lücken); die Kennzahlen `tage_leer`/`anteil_leer` zählen weiterhin ALLE leeren
 * Tage — sonst würde die Verfügbarkeitsquote schöngerechnet.
 */
export function findeLeerphasen(
  staende: TagesStand[],
  opts: { mindest_tage?: number } = {},
): ProduktHistorie | null {
  const mindest = Math.max(1, opts.mindest_tage ?? 1);

  // Je Tag der letzte Wert; sortiert.
  const proTag = new Map<string, TagesStand>();
  for (const s of staende) {
    if (!s?.datum) continue;
    proTag.set(String(s.datum).slice(0, 10), s);
  }
  const tage = [...proTag.keys()].sort();
  if (tage.length === 0) return null;

  const von = tage[0];
  const bis = tage[tage.length - 1];
  const abdeckung = tageZwischen(von, bis);

  // Lückenlose Tagesreihe: fehlende Tage erben den letzten gemessenen Endbestand.
  const reihe: { datum: string; menge: number; verkauft: number; gemessen: boolean }[] = [];
  let letzte = proTag.get(von)!.menge;
  for (let i = 0; i < abdeckung; i++) {
    const d = tagPlus(von, i);
    const gemessen = proTag.get(d);
    if (gemessen) letzte = gemessen.menge;
    reihe.push({
      datum: d,
      menge: letzte,
      verkauft: Math.max(0, Number(gemessen?.verkauft ?? 0)) || 0,
      gemessen: Boolean(gemessen),
    });
  }

  // Verkaufsgeschwindigkeit NUR aus Tagen mit Bestand — an leeren Tagen kann
  // niemand kaufen, sie würden die Geschwindigkeit künstlich drücken.
  const mitBestand = reihe.filter((r) => r.menge > 0 && r.gemessen);
  const velo = mitBestand.length > 0
    ? mitBestand.reduce((s, r) => s + r.verkauft, 0) / mitBestand.length
    : null;

  // Zusammenhängende Nullbestands-Strecken.
  const alle: Leerphase[] = [];
  let start: number | null = null;
  for (let i = 0; i <= reihe.length; i++) {
    const leer = i < reihe.length && reihe[i].menge === 0;
    if (leer && start === null) start = i;
    if (!leer && start !== null) {
      alle.push(baue(reihe, start, i - 1, velo, bis));
      start = null;
    }
  }

  const tageLeer = alle.reduce((s, p) => s + p.tage, 0);
  const sichtbar = alle.filter((p) => p.tage >= mindest);
  const letzterTag = reihe[reihe.length - 1];

  return {
    abdeckung_von: von,
    abdeckung_bis: bis,
    abdeckung_tage: abdeckung,
    gemessene_tage: tage.length,
    luecken_tage: abdeckung - tage.length,
    phasen: sichtbar,
    tage_leer: tageLeer,
    anteil_leer: abdeckung > 0 ? tageLeer / abdeckung : 0,
    laengste_phase_tage: alle.reduce((m, p) => Math.max(m, p.tage), 0),
    aktuell_leer: letzterTag.menge === 0,
    letzter_stand: letzterTag.menge,
    velo_tag: velo,
    entgangene_einheiten: velo == null ? null : Math.round(velo * tageLeer),
  };
}

function baue(
  reihe: { datum: string; gemessen: boolean }[],
  a: number,
  b: number,
  velo: number | null,
  letzterMesstag: string,
): Leerphase {
  const vonTag = reihe[a].datum;
  const bisTag = reihe[b].datum;
  const laufend = bisTag === letzterMesstag;
  const tage = b - a + 1;
  let luecken = 0;
  for (let i = a; i <= b; i++) if (!reihe[i].gemessen) luecken++;
  return {
    von: vonTag,
    bis: laufend ? null : bisTag,
    tage,
    laufend,
    luecken_tage: luecken,
    entgangene_einheiten: velo == null ? null : Math.round(velo * tage),
  };
}

// --- DB-Wrapper ---

export const STANDARD_TAGE = 365;
/** Ab dieser Verzögerung gilt der Verlauf als nicht mehr aktuell. */
export const FRISCHE_TAGE = 3;

export interface HistorieZeile extends ProduktHistorie {
  asin: string;
  produktname: string;
  /**
   * Wie viele Tage der letzte eigene Messwert hinter dem Kontostand liegt.
   * 0 = so aktuell wie das Konto. Grösser 0 heisst: Amazon meldet für dieses
   * Produkt seither nichts mehr — typisch, wenn nichts mehr im Lager liegt und
   * sich nichts bewegt. `aktuell_leer` bezieht sich dann auf DIESEN Tag, nicht
   * auf heute.
   */
  stand_alt_tage: number;
}

/**
 * Bestandshistorie aller Produkte eines Kontos. Liest die aggregierte Tagesreihe
 * (RPC `bestandsverlauf_basis`), leitet je Produkt die Leerphasen ab und sortiert
 * nach Schwere: aktuell leer zuerst, dann nach leeren Tagen.
 */
export async function bestandshistorie(
  supabase: any,
  tenant_id: string,
  opts: { tage?: number; mindest_tage?: number } = {},
): Promise<unknown> {
  const fenster = Math.max(30, Number(opts.tage) || STANDARD_TAGE);
  const mindest = Math.max(1, Number(opts.mindest_tage) || 1);
  const von = new Date(Date.now() - fenster * TAG_MS).toISOString().slice(0, 10);

  const [basisRes, asinRes] = await Promise.all([
    supabase.rpc("bestandsverlauf_basis", { p_tenant: tenant_id, p_von: von }),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
  ]);
  if (basisRes.error) throw new Error(basisRes.error.message);

  const titel = new Map<string, string>(
    ((asinRes.data ?? []) as any[]).map((a) => [String(a.asin), String(a.produktname ?? a.asin)]),
  );

  const proAsin = new Map<string, TagesStand[]>();
  for (const r of (basisRes.data ?? []) as any[]) {
    const key = String(r.asin);
    const liste = proAsin.get(key) ?? [];
    liste.push({
      datum: String(r.datum).slice(0, 10),
      menge: Number(r.menge) || 0,
      verkauft: Number(r.verkauft) || 0,
    });
    proAsin.set(key, liste);
  }

  const zeilen: HistorieZeile[] = [];
  for (const [asin, staende] of proAsin) {
    const h = findeLeerphasen(staende, { mindest_tage: mindest });
    if (!h) continue;
    zeilen.push({ asin, produktname: titel.get(asin) ?? asin, stand_alt_tage: 0, ...h });
  }

  // Kontostand = der jüngste Tag, für den überhaupt gemessen wurde. Produkte, die
  // früher enden, sind nicht „unauffällig", sondern seither ungemeldet.
  const stand = zeilen.reduce<string | null>(
    (m, z) => (m == null || z.abdeckung_bis > m ? z.abdeckung_bis : m),
    null,
  );
  if (stand) for (const z of zeilen) z.stand_alt_tage = tageZwischen(z.abdeckung_bis, stand) - 1;

  zeilen.sort((a, b) =>
    Number(b.aktuell_leer) - Number(a.aktuell_leer) ||
    b.tage_leer - a.tage_leer ||
    a.produktname.localeCompare(b.produktname)
  );

  const heute = new Date().toISOString().slice(0, 10);

  return {
    fenster_tage: fenster,
    mindest_tage: mindest,
    stand,                       // letzter Tag, für den überhaupt gemessen wurde
    veraltet: stand == null ? true : tageZwischen(stand, heute) - 1 > FRISCHE_TAGE,
    hat_daten: zeilen.length > 0,
    anzahl_produkte: zeilen.length,
    anzahl_aktuell_leer: zeilen.filter((z) => z.aktuell_leer).length,
    anzahl_mit_phasen: zeilen.filter((z) => z.phasen.length > 0).length,
    tage_leer_gesamt: zeilen.reduce((s, z) => s + z.tage_leer, 0),
    entgangene_einheiten_gesamt: zeilen.reduce(
      (s, z) => s + (z.entgangene_einheiten ?? 0),
      0,
    ),
    zeilen,
  };
}

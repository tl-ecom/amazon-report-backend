// bestandsplanung.ts — Nachbestellen mit Datum und Menge statt nur einer Warnung.
//
// Der Nachschub-Radar (stockouts.ts) sagt, WAS gerade brennt. Dieses Modul
// sagt fuer jedes Produkt, WANN spaetestens bestellt werden muss und WIE VIEL —
// und zeigt als Zeitachse, wie sich der FBA-Bestand entwickelt.
//
// Vorbild ist die Bestandszeitachse der Planungswerkzeuge (SoStocked u. a.):
// Der Bestand faellt mit der Verkaufsgeschwindigkeit, springt mit jeder
// Ankunft, und die Bestellung wird von der Luecke her RUECKWAERTS terminiert:
//
//   spaetestens bestellen = leer am − (Lieferzeit + Transit) − Mindest-Reichweite
//   Bestellmenge          = Absatz ab Ankunft ueber die Zielreichweite
//                           − was bei Ankunft noch da ist (inkl. bekannter Zulaeufe)
//
// EHRLICHKEITSREGELN (die hier nicht brechen duerfen):
//  * Ohne Lagerdatensatz keine Planung: "unbekannt", nicht 0.
//  * Amazons Zulauf hat kein Ankunftsdatum. Er wird nach ZULAUF_ANNAHME_TAGE
//    eingebucht — eine benannte Annahme, keine Messung. Eigene Bestellungen
//    tragen ihr Datum selbst.
//  * Die Verkaufsgeschwindigkeit wird um ausverkaufte Tage bereinigt, sobald
//    der Ledger sie kennt: an einem leeren Tag kann niemand kaufen. Solche Tage
//    druecken die Geschwindigkeit und fuehren geradewegs in die naechste Luecke.
//  * Die Vorjahres-Kurve gilt nur, wo es Vorjahresdaten gibt; sonst Rueckfall
//    auf die aktuelle Geschwindigkeit — und das steht dran.
//  * Vorgaben, die niemand gesetzt hat, sind Standardwerte und werden als
//    solche ausgewiesen (quelle: "standard").

import { findeLeerphasen, type TagesStand } from "./bestandshistorie.ts";
import { externJeAsin } from "./bestand_gesamt.ts";

// --- Methodik-Parameter (bewusst benannt) ------------------------------------

export interface Parameter {
  lieferzeit_tage: number;      // Produktion beim Hersteller
  transit_tage: number;         // Transport bis Amazon inkl. Wareneingang
  min_reichweite_tage: number;  // Sicherheitspolster, das bei Ankunft noch da sein soll
  max_reichweite_tage: number;  // Zielreichweite, auf die eine Bestellung auffuellt
}

/**
 * Standardwerte, wenn weder Firma noch Produkt etwas gesetzt haben.
 * 28 Tage Mindest-Reichweite ist Amazons eigene Schwelle fuer die Gebuehr bei
 * niedrigem Lagerbestand (siehe stockouts.ts). Lieferzeit und Transit sind
 * typische Werte fuer Ware aus Fernost per See — ausdruecklich zu ersetzen.
 */
export const STANDARD_PARAMETER: Parameter = {
  lieferzeit_tage: 30,
  transit_tage: 30,
  min_reichweite_tage: 28,
  max_reichweite_tage: 90,
};

/** Amazons Zulauf (shipped/working/receiving) ohne Ankunftsdatum: Annahme. */
export const ZULAUF_ANNAHME_TAGE = 14;
export const HORIZONT_STANDARD = 180;
export const HORIZONT_MAX = 365;
/** Wie weit die Simulation nach einer Luecke sucht — ueber den Horizont hinaus. */
export const SUCHTIEFE_TAGE = 365 + 120;
/** Unter so vielen Messtagen ist eine Geschwindigkeit nur ein Anhaltspunkt. */
export const MIN_MESSTAGE = 7;
/** Statusgrenzen in Tagen bis zum spaetesten Bestelltermin. */
export const JETZT_TAGE = 7;
export const BALD_TAGE = 30;
/** Ueberbestand: mehr als das X-fache der Zielreichweite im Lager. */
export const UEBERBESTAND_FAKTOR = 2;
/** Wie weit die Absatzhistorie fuer die Vorjahres-Kurve zurueckgelesen wird. */
export const HISTORIE_TAGE = 400;

export const VELOCITY_ARTEN = ["aktuell_30", "aktuell_90", "vorjahr", "vorjahr_skaliert"] as const;
export type VelocityArt = (typeof VELOCITY_ARTEN)[number];
export const VELOCITY_STANDARD: VelocityArt = "aktuell_90";

export type PlanStatus =
  | "leer"          // Bestand 0 — jetzt kostet jeder Tag
  | "ueberfaellig"  // spaetester Bestelltermin liegt in der Vergangenheit
  | "jetzt"         // Bestelltermin innerhalb JETZT_TAGE
  | "bald"          // Bestelltermin innerhalb BALD_TAGE
  | "ok"
  | "ueberbestand"  // deutlich mehr im Lager als die Zielreichweite
  | "kein_absatz"   // Bestand da, aber keine Verkaufsgeschwindigkeit
  | "unbekannt";    // kein Lagerdatensatz

const STATUS_RANG: Record<PlanStatus, number> = {
  leer: 0, ueberfaellig: 1, jetzt: 2, bald: 3, ok: 4, ueberbestand: 5, kein_absatz: 6, unbekannt: 7,
};

// --- Datumshelfer -----------------------------------------------------------

const TAG_MS = 86_400_000;

export function tagPlus(datum: string, n: number): string {
  return new Date(Date.parse(datum + "T00:00:00Z") + n * TAG_MS).toISOString().slice(0, 10);
}

/** Tage von a nach b (b − a); negativ, wenn b vor a liegt. */
export function tagDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / TAG_MS);
}

/** Montag der Kalenderwoche, in der `datum` liegt (wie date_trunc('week')). */
export function wochenstart(datum: string): string {
  const d = new Date(datum + "T00:00:00Z");
  const versatz = (d.getUTCDay() + 6) % 7; // Mo=0 … So=6
  return tagPlus(datum, -versatz);
}

/** Derselbe Kalendertag ein Jahr frueher (29.02. wird zum 01.03.). */
export function vorjahrTag(datum: string): string {
  const d = new Date(datum + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// --- Verkaufsgeschwindigkeit ------------------------------------------------

/** Stueck je Tag am Tag heute+i. Konstant oder als Kurve (Vorjahr). */
export type Velocity = (tagIndex: number) => number;

export function konstant(v: number): Velocity {
  const x = Math.max(0, nz(v));
  return () => x;
}

export interface BereinigteVelocity {
  velo: number;
  /** Tage im Fenster, an denen Bestand da war (= Tage, an denen gemessen wurde). */
  messtage: number;
  /** true = ausverkaufte Tage wurden herausgerechnet (Ledger vorhanden). */
  bereinigt: boolean;
  /** Weniger als MIN_MESSTAGE Tage mit Bestand: nur ein Anhaltspunkt. */
  unsicher: boolean;
}

/**
 * Einheiten ÷ Tage MIT Bestand. Ohne Ledger (leerTage = null) gilt das ganze
 * Fenster als Messzeit — dann ist die Zahl bei Luecken zu niedrig, und das
 * wird ueber `bereinigt: false` sichtbar.
 *
 * Bei sehr wenigen Messtagen wird der Nenner auf MIN_MESSTAGE gehalten:
 * zwei gute Tage auf einen Monat hochzurechnen waere keine Messung mehr.
 */
export function bereinigteVelocity(units: number, fensterTage: number, leerTage: number | null): BereinigteVelocity {
  const u = Math.max(0, nz(units));
  const fenster = Math.max(1, Math.round(nz(fensterTage)));
  if (leerTage == null) {
    return { velo: u / fenster, messtage: fenster, bereinigt: false, unsicher: false };
  }
  const messtage = Math.max(0, fenster - Math.max(0, Math.round(nz(leerTage))));
  const unsicher = messtage < MIN_MESSTAGE;
  return { velo: u / Math.max(MIN_MESSTAGE, messtage), messtage, bereinigt: true, unsicher };
}

export interface VorjahrKurve {
  velocity: Velocity;
  /** Anteil der Tage im Horizont, fuer die es echte Vorjahresdaten gibt (0..1). */
  abdeckung: (horizontTage: number) => number;
}

/**
 * Vorjahres-Kurve: fuer heute+i zaehlt die Kalenderwoche, in der derselbe Tag
 * vor einem Jahr lag. Wochenabsatz ÷ Tage mit Bestand in dieser Woche.
 *
 * `wochen` enthaelt nur Wochen mit Verkaeufen; eine fehlende Woche ab
 * `abdeckung_von` heisst 0 (es gab Daten, nur keinen Verkauf), davor heisst sie
 * unbekannt -> `rueckfall`. War das Produkt die ganze Woche leer, ist der
 * Bedarf des Vorjahres unbekannt -> ebenfalls `rueckfall`.
 *
 * `faktor` skaliert die Kurve (aktuelles Wachstum gegenueber dem Vorjahr);
 * null = unveraendert.
 */
export function vorjahrKurve(opts: {
  heute: string;
  wochen: Map<string, number>;
  leerTageJeWoche?: Map<string, number>;
  abdeckung_von: string;
  faktor: number | null;
  rueckfall: number;
}): VorjahrKurve {
  const f = opts.faktor != null && Number.isFinite(opts.faktor) && opts.faktor > 0 ? opts.faktor : 1;
  const rueckfall = Math.max(0, nz(opts.rueckfall));
  const abdeckungMontag = wochenstart(opts.abdeckung_von);

  const amTag = (i: number): { velo: number; echt: boolean } => {
    const vj = vorjahrTag(tagPlus(opts.heute, i));
    const montag = wochenstart(vj);
    if (montag < abdeckungMontag) return { velo: rueckfall, echt: false };
    const leer = opts.leerTageJeWoche?.get(montag) ?? 0;
    const tageMitBestand = Math.max(0, 7 - leer);
    if (tageMitBestand === 0) return { velo: rueckfall, echt: false };
    const units = opts.wochen.get(montag) ?? 0;
    return { velo: (units / tageMitBestand) * f, echt: true };
  };

  return {
    velocity: (i) => amTag(i).velo,
    abdeckung: (horizont) => {
      const n = Math.max(1, Math.round(horizont));
      let echt = 0;
      for (let i = 0; i < n; i++) if (amTag(i).echt) echt++;
      return echt / n;
    },
  };
}

// --- Planung EINER ASIN (rein) ----------------------------------------------

export interface Zulauf {
  datum: string;
  menge: number;
  art: "amazon" | "bestellung";
}

export interface PlanEingabe {
  heute: string;
  /** Verkaufsfaehiger FBA-Bestand. null = unbekannt. */
  bestand: number | null;
  bestand_bekannt: boolean;
  /** Eigenes Lager (transferierbar). null = keins/unbekannt. */
  lager_bestand: number | null;
  zulaeufe: Zulauf[];
  velocity: Velocity;
  parameter: Parameter;
  horizont_tage: number;
}

export interface Projektionspunkt {
  datum: string;
  /** Bestand am Ende des Tages. */
  bestand: number;
  zulauf: number;
}

export interface PlanErgebnis {
  status: PlanStatus;
  /** Tage bis der Bestand (inkl. bekannter Zulaeufe) auf 0 faellt. null = nicht im Suchfenster. */
  reichweite_tage: number | null;
  /** Dasselbe ohne jeden Zulauf — die vorsichtige Zahl. */
  reichweite_ohne_zulauf_tage: number | null;
  /** Erster Tag mit 0 Bestand. */
  leer_am: string | null;
  /** Die Luecke, auf die die Bestellung zielt: die erste NACH einer Phase mit Bestand. */
  planungs_leer_am: string | null;
  bestellpunkt_am: string | null;
  /** Tage bis zum spaetesten Bestelltermin; negativ = ueberfaellig. */
  bestellen_bis_tage: number | null;
  /** Ankunft, wenn am Bestellpunkt (fruehestens heute) bestellt wird. */
  ankunft_am: string | null;
  /** Einheiten, die bei Ankunft fuer die Zielreichweite fehlen. */
  bedarf_einheiten: number;
  /** Davon zu bestellen — nach Abzug des eigenen Lagers. */
  bestellmenge: number;
  /** Ø Stueck/Tag ueber die naechsten 90 Tage der gewaehlten Kurve. */
  velo_tag: number;
  projektion: Projektionspunkt[];
}

function leeresErgebnis(status: PlanStatus): PlanErgebnis {
  return {
    status, reichweite_tage: null, reichweite_ohne_zulauf_tage: null, leer_am: null,
    planungs_leer_am: null, bestellpunkt_am: null, bestellen_bis_tage: null, ankunft_am: null,
    bedarf_einheiten: 0, bestellmenge: 0, velo_tag: 0, projektion: [],
  };
}

interface Simulation {
  punkte: Projektionspunkt[];
  leer_am: string | null;
  planungs_leer_am: string | null;
  reichweite_tage: number | null;
}

/**
 * Tag fuer Tag: Bestand + Zulauf − Absatz, nie unter 0. Zulaeufe mit Datum vor
 * heute gelten als heute eintreffend (sie sind ueberfaellig, nicht weg).
 */
function simuliere(
  start: number, zulaeufe: Zulauf[], velocity: Velocity, heute: string, tage: number,
): Simulation {
  const zulaufAm = new Map<number, number>();
  for (const z of zulaeufe) {
    const i = Math.max(0, tagDiff(heute, z.datum));
    zulaufAm.set(i, (zulaufAm.get(i) ?? 0) + Math.max(0, nz(z.menge)));
  }

  const punkte: Projektionspunkt[] = [];
  let b = Math.max(0, start);
  let leerAm: string | null = null;
  let planungsLeerAm: string | null = null;
  let reichweite: number | null = null;
  let hatteBestand = b > 0;

  for (let i = 0; i <= tage; i++) {
    const zulauf = zulaufAm.get(i) ?? 0;
    const vor = b + zulauf;
    if (vor > 0) hatteBestand = true;
    const velo = Math.max(0, velocity(i));
    const nach = vor - velo;
    const datum = tagPlus(heute, i);

    if (nach <= 0) {
      if (leerAm === null) {
        leerAm = datum;
        reichweite = velo > 0 ? i + vor / velo : i;
      }
      // Die Planungs-Luecke ist die erste, die auf eine Phase MIT Bestand folgt.
      // Ist das Lager jetzt leer und wird nie gefuellt, ist sie heute.
      if (planungsLeerAm === null && hatteBestand) planungsLeerAm = datum;
      b = 0;
    } else {
      b = nach;
    }
    punkte.push({ datum, bestand: Math.round(b * 10) / 10, zulauf });
  }
  // Jetzt leer und im ganzen Fenster nie gefuellt: die Luecke ist heute.
  if (leerAm !== null && planungsLeerAm === null && !hatteBestand) planungsLeerAm = leerAm;
  return { punkte, leer_am: leerAm, planungs_leer_am: planungsLeerAm, reichweite_tage: reichweite };
}

export function planeAsin(e: PlanEingabe): PlanErgebnis {
  if (!e.bestand_bekannt || e.bestand == null) return leeresErgebnis("unbekannt");

  const p = e.parameter;
  const horizont = Math.max(1, Math.min(HORIZONT_MAX, Math.round(nz(e.horizont_tage) || HORIZONT_STANDARD)));
  const suchtiefe = Math.max(horizont, SUCHTIEFE_TAGE) + p.lieferzeit_tage + p.transit_tage + p.max_reichweite_tage;

  // Ø-Geschwindigkeit der naechsten 90 Tage — die Zahl, die in der Tabelle steht.
  let summe90 = 0;
  for (let i = 0; i < 90; i++) summe90 += Math.max(0, e.velocity(i));
  const veloTag = summe90 / 90;

  let absatzImFenster = 0;
  for (let i = 0; i < suchtiefe; i++) absatzImFenster += Math.max(0, e.velocity(i));

  const bestand = Math.max(0, nz(e.bestand));
  const mit = simuliere(bestand, e.zulaeufe, e.velocity, e.heute, suchtiefe);
  const ohne = simuliere(bestand, [], e.velocity, e.heute, suchtiefe);
  const projektion = mit.punkte.slice(0, horizont + 1);

  if (absatzImFenster <= 0) {
    return {
      ...leeresErgebnis(bestand === 0 ? "leer" : "kein_absatz"),
      projektion,
      reichweite_tage: null,
      reichweite_ohne_zulauf_tage: null,
    };
  }

  const lt = p.lieferzeit_tage + p.transit_tage;
  let bestellpunkt: string | null = null;
  let bestellenBis: number | null = null;
  let ankunft: string | null = null;
  let bedarf = 0;

  if (mit.planungs_leer_am) {
    bestellpunkt = tagPlus(mit.planungs_leer_am, -(lt + p.min_reichweite_tage));
    bestellenBis = tagDiff(e.heute, bestellpunkt);
    const bestellTag = Math.max(0, bestellenBis);
    ankunft = tagPlus(e.heute, bestellTag + lt);
    const iAnk = bestellTag + lt;

    // Bedarf ab Ankunft ueber die Zielreichweite, abzueglich dessen, was dann
    // noch da ist (Bestand am Vorabend + Zulaeufe innerhalb des Fensters).
    let absatz = 0;
    let zulaufImFenster = 0;
    for (let i = iAnk; i < iAnk + p.max_reichweite_tage; i++) {
      absatz += Math.max(0, e.velocity(i));
      zulaufImFenster += mit.punkte[i]?.zulauf ?? 0;
    }
    const vorrat = iAnk > 0 ? (mit.punkte[iAnk - 1]?.bestand ?? 0) : bestand;
    bedarf = Math.max(0, Math.ceil(absatz - vorrat - zulaufImFenster));
  }

  const lager = Math.max(0, nz(e.lager_bestand));
  const bestellmenge = Math.max(0, bedarf - lager);

  let status: PlanStatus;
  if (bestand === 0) status = "leer";
  else if (mit.reichweite_tage != null && mit.reichweite_tage > UEBERBESTAND_FAKTOR * p.max_reichweite_tage) status = "ueberbestand";
  else if (mit.reichweite_tage == null && bestellenBis == null) status = "ueberbestand";
  else if (bestellenBis == null) status = "ok";
  else if (bestellenBis < 0) status = "ueberfaellig";
  else if (bestellenBis <= JETZT_TAGE) status = "jetzt";
  else if (bestellenBis <= BALD_TAGE) status = "bald";
  else status = "ok";

  return {
    status,
    reichweite_tage: mit.reichweite_tage == null ? null : Math.round(mit.reichweite_tage * 10) / 10,
    reichweite_ohne_zulauf_tage: ohne.reichweite_tage == null ? null : Math.round(ohne.reichweite_tage * 10) / 10,
    leer_am: mit.leer_am,
    planungs_leer_am: mit.planungs_leer_am,
    bestellpunkt_am: bestellpunkt,
    bestellen_bis_tage: bestellenBis,
    ankunft_am: ankunft,
    bedarf_einheiten: bedarf,
    bestellmenge,
    velo_tag: Math.round(veloTag * 1000) / 1000,
    projektion,
  };
}

// --- Leertage aus dem Ledger -------------------------------------------------

/**
 * Alle Tage mit 0 verkaufsfaehigem Bestand je ASIN, aus den Leerphasen der
 * Bestandshistorie (dort fortgeschrieben und getestet). Offene Phasen laufen
 * bis zum letzten Messtag des Produkts.
 */
export function leerTageAusVerlauf(staende: TagesStand[]): Set<string> {
  const tage = new Set<string>();
  const h = findeLeerphasen(staende, { mindest_tage: 1 });
  if (!h) return tage;
  for (const ph of h.phasen) {
    const bis = ph.bis ?? h.abdeckung_bis;
    for (let d = ph.von; d <= bis; d = tagPlus(d, 1)) tage.add(d);
  }
  return tage;
}

/** Wie viele der Leertage in [von, bis) liegen. */
export function zaehleLeerTage(leer: Set<string>, von: string, bis: string): number {
  let n = 0;
  for (const d of leer) if (d >= von && d < bis) n++;
  return n;
}

export function leerTageJeWoche(leer: Set<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of leer) {
    const w = wochenstart(d);
    m.set(w, (m.get(w) ?? 0) + 1);
  }
  return m;
}

// --- Parameter zusammenfuehren ------------------------------------------------

export type ParameterQuelle = "produkt" | "firma" | "standard";

export interface ParameterMitQuelle extends Parameter {
  quelle: Record<keyof Parameter, ParameterQuelle>;
}

const PARAM_FELDER: Array<keyof Parameter> = ["lieferzeit_tage", "transit_tage", "min_reichweite_tage", "max_reichweite_tage"];

/** Produkt vor Firma vor Standard — je Feld, und die Herkunft steht dran. */
export function fuehreParameterZusammen(
  produkt: Partial<Record<keyof Parameter, number | null>> | null,
  firma: Partial<Record<keyof Parameter, number | null>> | null,
): ParameterMitQuelle {
  const out = { ...STANDARD_PARAMETER, quelle: {} as Record<keyof Parameter, ParameterQuelle> };
  for (const f of PARAM_FELDER) {
    const p = produkt?.[f];
    const t = firma?.[f];
    if (p != null && Number.isFinite(Number(p))) { out[f] = Number(p); out.quelle[f] = "produkt"; }
    else if (t != null && Number.isFinite(Number(t))) { out[f] = Number(t); out.quelle[f] = "firma"; }
    else out.quelle[f] = "standard";
  }
  return out;
}

// --- Eigenes Lager: manuell oder aus Sellerboard ----------------------------

export interface LagerQuelle {
  menge: number | null;
  quelle: "manuell" | "sellerboard" | null;
}

/**
 * Eigenes Lager (transferierbar). Eine manuelle Angabe je Produkt schlaegt die
 * automatische Quelle — wer den Wert eintraegt, weiss etwas, das der Feed nicht
 * weiss. Ohne beides: null, nicht 0.
 */
export function effektivesLager(manuell: number | null, extern: number | null): LagerQuelle {
  if (manuell != null && Number.isFinite(manuell)) return { menge: Math.max(0, manuell), quelle: "manuell" };
  if (extern != null && Number.isFinite(extern)) return { menge: Math.max(0, extern), quelle: "sellerboard" };
  return { menge: null, quelle: null };
}

/**
 * Beim Lieferanten bestellte Ware laut Feed (ohne Ankunftsdatum). Sie mindert
 * die Bestellmenge — aber nur, wenn fuer das Produkt KEINE eigenen offenen
 * Bestellungen erfasst sind: die eigenen Eintraege sind der genauere Datensatz
 * (mit Termin), und dieselbe Bestellung darf nicht doppelt zaehlen.
 */
export function anrechenbarBestellt(externBestellt: number | null, eigeneOffene: number): number {
  if (eigeneOffene > 0) return 0;
  return Math.max(0, nz(externBestellt));
}

// --- DB-Wrapper: Planung ----------------------------------------------------

export interface PlanungArgs {
  velocity_art?: unknown;
  horizont_tage?: unknown;
  /** Nur fuer diese ASIN die Tageskurve mitschicken (Zeitachse). */
  projektion_asin?: unknown;
}

const OFFENE_STATUS = ["bestellt", "produktion", "unterwegs"];

export async function bestandsplanung(supabase: any, tenant_id: string, args: PlanungArgs = {}): Promise<unknown> {
  const heute = new Date().toISOString().slice(0, 10);
  const von = tagPlus(heute, -HISTORIE_TAGE);
  const horizont = Math.max(30, Math.min(HORIZONT_MAX, Math.round(Number(args.horizont_tage)) || HORIZONT_STANDARD));
  const projektionAsin = args.projektion_asin ? String(args.projektion_asin).toUpperCase() : null;

  const [basisRes, wochenRes, verlaufRes, asinRes, planungRes, firmaRes, bestellRes, extern] = await Promise.all([
    supabase.rpc("bestandsplanung_basis", { p_tenant: tenant_id }),
    supabase.rpc("bestandsplanung_wochen", { p_tenant: tenant_id, p_von: von }),
    supabase.rpc("bestandsverlauf_basis", { p_tenant: tenant_id, p_von: von }),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
    supabase.from("asin_planung")
      .select("asin, lieferzeit_tage, transit_tage, min_reichweite_tage, max_reichweite_tage, lager_bestand")
      .eq("tenant_id", tenant_id),
    supabase.from("tenant_einstellungen")
      .select("plan_lieferzeit_tage, plan_transit_tage, plan_min_reichweite_tage, plan_max_reichweite_tage, plan_velocity_art")
      .eq("tenant_id", tenant_id).maybeSingle(),
    supabase.from("bestellungen")
      .select("id, asin, menge, bestellt_am, erwartet_am, status, ziel, lieferant, referenz, notiz, eingetroffen_am, created_at")
      .eq("tenant_id", tenant_id).order("erwartet_am", { ascending: true }).limit(500),
    // Externe Bestaende (Sellerboard-Feed): eigenes Lager, Prep Center, 3PL,
    // bestellte Ware. Leere Map, wenn der Mandant keine Quelle hat.
    externJeAsin(supabase, tenant_id),
  ]);
  if (basisRes.error) throw new Error(`bestandsplanung_basis: ${basisRes.error.message}`);
  if (wochenRes.error) throw new Error(`bestandsplanung_wochen: ${wochenRes.error.message}`);

  const titel = new Map<string, string>(
    ((asinRes.data ?? []) as any[]).map((a) => [String(a.asin), String(a.produktname ?? a.asin)]),
  );

  // Firmenvorgabe + Velocity-Art.
  const firma = (firmaRes?.data ?? null) as any;
  const firmaParam = firma
    ? {
      lieferzeit_tage: firma.plan_lieferzeit_tage, transit_tage: firma.plan_transit_tage,
      min_reichweite_tage: firma.plan_min_reichweite_tage, max_reichweite_tage: firma.plan_max_reichweite_tage,
    }
    : null;
  const artGewuenscht = String(args.velocity_art ?? firma?.plan_velocity_art ?? VELOCITY_STANDARD) as VelocityArt;
  const velocityArt: VelocityArt = (VELOCITY_ARTEN as readonly string[]).includes(artGewuenscht) ? artGewuenscht : VELOCITY_STANDARD;

  // Leertage je ASIN aus dem Ledger (falls vorhanden).
  const verlaufJeAsin = new Map<string, TagesStand[]>();
  for (const r of ((verlaufRes?.data ?? []) as any[])) {
    const key = String(r.asin);
    const liste = verlaufJeAsin.get(key) ?? [];
    liste.push({ datum: String(r.datum).slice(0, 10), menge: Number(r.menge) || 0, verkauft: Number(r.verkauft) || 0 });
    verlaufJeAsin.set(key, liste);
  }
  const ledgerVorhanden = verlaufJeAsin.size > 0;

  // Wochenabsatz je ASIN.
  const wochenJeAsin = new Map<string, Map<string, number>>();
  for (const r of ((wochenRes.data ?? []) as any[])) {
    const key = String(r.asin);
    const m = wochenJeAsin.get(key) ?? new Map<string, number>();
    m.set(String(r.woche).slice(0, 10), Number(r.units) || 0);
    wochenJeAsin.set(key, m);
  }

  const planungJeAsin = new Map<string, any>(((planungRes?.data ?? []) as any[]).map((p) => [String(p.asin), p]));

  // Bestellungen: offene je ASIN (fuer die Zeitachse) und die Liste (fuer den Tab).
  const bestellungen = ((bestellRes?.data ?? []) as any[]).map((b) => ({
    id: String(b.id), asin: String(b.asin), produktname: titel.get(String(b.asin)) ?? String(b.asin),
    menge: Number(b.menge) || 0, bestellt_am: String(b.bestellt_am).slice(0, 10),
    erwartet_am: String(b.erwartet_am).slice(0, 10), status: String(b.status), ziel: String(b.ziel),
    lieferant: b.lieferant ?? null, referenz: b.referenz ?? null, notiz: b.notiz ?? null,
    eingetroffen_am: b.eingetroffen_am ? String(b.eingetroffen_am).slice(0, 10) : null,
    offen: OFFENE_STATUS.includes(String(b.status)),
    ueberfaellig: OFFENE_STATUS.includes(String(b.status)) && String(b.erwartet_am).slice(0, 10) < heute,
  }));
  const offeneJeAsin = new Map<string, typeof bestellungen>();
  for (const b of bestellungen) {
    if (!b.offen) continue;
    const l = offeneJeAsin.get(b.asin) ?? [];
    l.push(b);
    offeneJeAsin.set(b.asin, l);
  }

  const von30 = tagPlus(heute, -30);
  const von90 = tagPlus(heute, -90);
  let vorjahrRueckfall = 0;

  // Ohne Lagerdatensatz UND ohne Verkauf in 90 Tagen gibt es nichts zu planen:
  // weder Bestand noch Geschwindigkeit. Solche Zeilen (bei grossen Katalogen
  // hunderte, einmal verkaufte ASINs) wuerden die Tabelle nur zuschuetten.
  const basisZeilen = ((basisRes.data ?? []) as any[]);
  const relevant = basisZeilen.filter((r) => Boolean(r.bestand_bekannt) || nz(r.units_90) > 0);
  const ausgeblendet = basisZeilen.length - relevant.length;

  const zeilen = relevant.map((r) => {
    const asin = String(r.asin);
    const planung = planungJeAsin.get(asin) ?? null;
    const parameter = fuehreParameterZusammen(planung, firmaParam);

    const leer = ledgerVorhanden ? leerTageAusVerlauf(verlaufJeAsin.get(asin) ?? []) : null;
    const leer30 = leer ? zaehleLeerTage(leer, von30, heute) : null;
    const leer90 = leer ? zaehleLeerTage(leer, von90, heute) : null;
    const v30 = bereinigteVelocity(nz(r.units_30), 30, leer30);
    const v90 = bereinigteVelocity(nz(r.units_90), 90, leer90);

    const units90 = nz(r.units_90);
    const unitsVj90 = nz(r.units_vorjahr_90);
    const faktor = units90 > 0 && unitsVj90 > 0 ? Math.round((units90 / unitsVj90) * 100) / 100 : null;

    let velocity: Velocity;
    let effektiveArt: VelocityArt = velocityArt;
    let vorjahrAbdeckung: number | null = null;
    if (velocityArt === "vorjahr" || velocityArt === "vorjahr_skaliert") {
      const kurve = vorjahrKurve({
        heute, wochen: wochenJeAsin.get(asin) ?? new Map(), leerTageJeWoche: leer ? leerTageJeWoche(leer) : undefined,
        abdeckung_von: von, faktor: velocityArt === "vorjahr_skaliert" ? faktor : null, rueckfall: v90.velo,
      });
      vorjahrAbdeckung = Math.round(kurve.abdeckung(horizont) * 100) / 100;
      if (vorjahrAbdeckung > 0) velocity = kurve.velocity;
      else { velocity = konstant(v90.velo); effektiveArt = "aktuell_90"; vorjahrRueckfall++; }
    } else {
      velocity = konstant(velocityArt === "aktuell_30" ? v30.velo : v90.velo);
    }

    const unterwegs = r.unterwegs == null ? null : nz(r.unterwegs);
    const zulaeufe: Zulauf[] = [];
    if (unterwegs != null && unterwegs > 0) zulaeufe.push({ datum: tagPlus(heute, ZULAUF_ANNAHME_TAGE), menge: unterwegs, art: "amazon" });
    const offene = offeneJeAsin.get(asin) ?? [];
    for (const b of offene) if (b.ziel === "fba") zulaeufe.push({ datum: b.erwartet_am, menge: b.menge, art: "bestellung" });
    const offeneLagerMenge = offene.filter((b) => b.ziel === "lager").reduce((s, b) => s + b.menge, 0);

    const ex = extern.get(asin) ?? null;
    const lager = effektivesLager(planung?.lager_bestand == null ? null : nz(planung.lager_bestand), ex ? ex.extern_physisch : null);
    const bestelltSb = anrechenbarBestellt(ex ? ex.ordered : null, offene.length);
    const lagerGesamt = (lager.menge ?? 0) + offeneLagerMenge + bestelltSb;
    const ergebnis = planeAsin({
      heute, bestand: r.bestand == null ? null : nz(r.bestand), bestand_bekannt: Boolean(r.bestand_bekannt),
      lager_bestand: lager.menge == null && offeneLagerMenge === 0 && bestelltSb === 0 ? null : lagerGesamt,
      zulaeufe, velocity, parameter, horizont_tage: horizont,
    });

    const { projektion, ...plan } = ergebnis;
    return {
      asin,
      produktname: titel.get(asin) ?? asin,
      bestand: r.bestand == null ? null : nz(r.bestand),
      unterwegs,
      bestand_bekannt: Boolean(r.bestand_bekannt),
      lager_bestand: lager.menge,
      lager_quelle: lager.quelle,
      lager_manuell: planung?.lager_bestand == null ? null : nz(planung.lager_bestand),
      // Sellerboard je ASIN. null = keine externe Quelle, nicht 0.
      extern_physisch: ex ? ex.extern_physisch : null,
      extern_bestellt: ex ? ex.ordered : null,
      extern_bestellt_angerechnet: bestelltSb,
      extern_pipeline: ex ? ex.pipeline_sonstig : null,
      extern_stand: ex?.stand ?? null,
      offene_lager_menge: offeneLagerMenge,
      offene_fba_menge: offene.filter((b) => b.ziel === "fba").reduce((s, b) => s + b.menge, 0),
      offene_bestellungen: offene.length,
      units_30: nz(r.units_30), units_90: units90, units_vorjahr_90: unitsVj90,
      letzter_verkauf: r.letzter_verkauf ?? null,
      avg_preis_cents: r.avg_preis_cents == null ? null : nz(r.avg_preis_cents),
      velo_30: Math.round(v30.velo * 1000) / 1000,
      velo_90: Math.round(v90.velo * 1000) / 1000,
      leertage_30: leer30, leertage_90: leer90,
      velocity_bereinigt: v90.bereinigt,
      velocity_unsicher: velocityArt === "aktuell_30" ? v30.unsicher : v90.unsicher,
      vorjahr_faktor: faktor,
      vorjahr_abdeckung: vorjahrAbdeckung,
      velocity_art_effektiv: effektiveArt,
      parameter,
      ...plan,
      ...(projektionAsin === asin ? { projektion } : {}),
    };
  });

  zeilen.sort((a, b) =>
    (STATUS_RANG[a.status as PlanStatus] - STATUS_RANG[b.status as PlanStatus]) ||
    ((a.bestellen_bis_tage ?? 9999) - (b.bestellen_bis_tage ?? 9999)) ||
    a.produktname.localeCompare(b.produktname)
  );

  const zaehle = (s: PlanStatus) => zeilen.filter((z) => z.status === s).length;
  const erste = ((basisRes.data ?? []) as any[]).find((r) => r.bestand_quelle);

  return {
    heute,
    horizont_tage: horizont,
    velocity_art: velocityArt,
    velocity_art_firma: firma?.plan_velocity_art ?? null,
    ledger_vorhanden: ledgerVorhanden,
    zulauf_annahme_tage: ZULAUF_ANNAHME_TAGE,
    standard: STANDARD_PARAMETER,
    vorgabe: {
      lieferzeit_tage: firmaParam?.lieferzeit_tage ?? null,
      transit_tage: firmaParam?.transit_tage ?? null,
      min_reichweite_tage: firmaParam?.min_reichweite_tage ?? null,
      max_reichweite_tage: firmaParam?.max_reichweite_tage ?? null,
    },
    bestand_quelle: erste?.bestand_quelle ?? null,
    bestand_stand: erste?.bestand_stand ?? null,
    zulauf_bekannt: ((basisRes.data ?? []) as any[]).some((r) => r.unterwegs != null),
    // Externe Quelle (Sellerboard): eigenes Lager wird daraus automatisch
    // gefuellt, solange je Produkt nichts Manuelles eingetragen ist.
    hat_externe_bestaende: extern.size > 0,
    extern_stand: [...extern.values()].reduce<string | null>((m, e) => (!m || (e.stand ?? "") > m ? e.stand : m), null),
    extern_quelle: extern.size > 0 ? ([...extern.values()][0]?.quelle ?? null) : null,
    anzahl: {
      leer: zaehle("leer"), ueberfaellig: zaehle("ueberfaellig"), jetzt: zaehle("jetzt"), bald: zaehle("bald"),
      ok: zaehle("ok"), ueberbestand: zaehle("ueberbestand"), kein_absatz: zaehle("kein_absatz"), unbekannt: zaehle("unbekannt"),
    },
    summe_bestellmenge_faellig: zeilen
      .filter((z) => z.status === "leer" || z.status === "ueberfaellig" || z.status === "jetzt")
      .reduce((s, z) => s + z.bestellmenge, 0),
    vorjahr_rueckfall_anzahl: vorjahrRueckfall,
    anzahl_produkte: zeilen.length,
    /** ASINs ohne Lagerdatensatz und ohne Verkauf in 90 Tagen — nicht planbar, nicht gelistet. */
    anzahl_ausgeblendet: ausgeblendet,
    zeilen,
    bestellungen,
    anzahl_offene_bestellungen: bestellungen.filter((b) => b.offen).length,
    anzahl_ueberfaellige_bestellungen: bestellungen.filter((b) => b.ueberfaellig).length,
  };
}

// --- DB-Wrapper: Aktionen ---------------------------------------------------

function pruefeAsin(v: unknown): string {
  const asin = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("Bitte eine gültige ASIN angeben (10 Zeichen).");
  return asin;
}

/** Ganze Zahl im Bereich; leer -> null (loescht die Angabe). */
function pruefeGanzzahl(v: unknown, feld: string, min: number, max: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(",", "."), 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${feld}: bitte ${min}–${max} angeben (oder leer lassen).`);
  return Math.round(n);
}

function pruefeDatum(v: unknown, feld: string): string {
  const s = String(v ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) {
    throw new Error(`${feld}: bitte ein Datum im Format JJJJ-MM-TT angeben.`);
  }
  return s;
}

function textOderNull(v: unknown, max = 200): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Planungsparameter EINES Produkts. Nur mitgeschickte Felder werden angefasst. */
export async function setzePlanung(
  supabase: any, tenant_id: string, args: Record<string, unknown>,
): Promise<{ ok: true; asin: string }> {
  const asin = pruefeAsin(args.asin);
  const satz: Record<string, unknown> = { tenant_id, asin, updated_at: new Date().toISOString() };
  if ("lieferzeit_tage" in args) satz.lieferzeit_tage = pruefeGanzzahl(args.lieferzeit_tage, "Lieferzeit", 0, 365);
  if ("transit_tage" in args) satz.transit_tage = pruefeGanzzahl(args.transit_tage, "Transit", 0, 365);
  if ("min_reichweite_tage" in args) satz.min_reichweite_tage = pruefeGanzzahl(args.min_reichweite_tage, "Mindest-Reichweite", 0, 365);
  if ("max_reichweite_tage" in args) satz.max_reichweite_tage = pruefeGanzzahl(args.max_reichweite_tage, "Zielreichweite", 1, 730);
  if ("lager_bestand" in args) satz.lager_bestand = pruefeGanzzahl(args.lager_bestand, "Lagerbestand", 0, 1_000_000);
  const { error } = await supabase.from("asin_planung").upsert(satz, { onConflict: "tenant_id,asin" });
  if (error) throw new Error(`asin_planung upsert: ${error.message}`);
  return { ok: true, asin };
}

/** Firmenvorgabe. Nur mitgeschickte Felder werden angefasst. */
export async function setzePlanungVorgabe(
  supabase: any, tenant_id: string, args: Record<string, unknown>,
): Promise<{ ok: true }> {
  const satz: Record<string, unknown> = { tenant_id, updated_at: new Date().toISOString() };
  if ("lieferzeit_tage" in args) satz.plan_lieferzeit_tage = pruefeGanzzahl(args.lieferzeit_tage, "Lieferzeit", 0, 365);
  if ("transit_tage" in args) satz.plan_transit_tage = pruefeGanzzahl(args.transit_tage, "Transit", 0, 365);
  if ("min_reichweite_tage" in args) satz.plan_min_reichweite_tage = pruefeGanzzahl(args.min_reichweite_tage, "Mindest-Reichweite", 0, 365);
  if ("max_reichweite_tage" in args) satz.plan_max_reichweite_tage = pruefeGanzzahl(args.max_reichweite_tage, "Zielreichweite", 1, 730);
  if ("velocity_art" in args) {
    const roh = args.velocity_art;
    if (roh === null || roh === undefined || roh === "") satz.plan_velocity_art = null;
    else if ((VELOCITY_ARTEN as readonly string[]).includes(String(roh))) satz.plan_velocity_art = String(roh);
    else throw new Error(`Geschwindigkeit: erlaubt sind ${VELOCITY_ARTEN.join(", ")}.`);
  }
  const { error } = await supabase.from("tenant_einstellungen").upsert(satz, { onConflict: "tenant_id" });
  if (error) throw new Error(`tenant_einstellungen upsert: ${error.message}`);
  return { ok: true };
}

export const BESTELL_STATUS = ["bestellt", "produktion", "unterwegs", "eingetroffen", "storniert"] as const;

export async function erstelleBestellung(
  supabase: any, tenant_id: string, userId: string | null, args: Record<string, unknown>,
): Promise<{ ok: true; id: string }> {
  const asin = pruefeAsin(args.asin);
  const menge = pruefeGanzzahl(args.menge, "Menge", 1, 1_000_000);
  if (menge == null) throw new Error("Menge fehlt.");
  const heute = new Date().toISOString().slice(0, 10);
  const bestelltAm = args.bestellt_am ? pruefeDatum(args.bestellt_am, "Bestellt am") : heute;
  const erwartetAm = pruefeDatum(args.erwartet_am, "Erwartet am");
  if (erwartetAm < bestelltAm) throw new Error("Erwartet am darf nicht vor dem Bestelldatum liegen.");
  const ziel = args.ziel === "lager" ? "lager" : "fba";
  const status = (BESTELL_STATUS as readonly string[]).includes(String(args.status)) ? String(args.status) : "bestellt";
  const { data, error } = await supabase.from("bestellungen").insert({
    tenant_id, asin, menge, bestellt_am: bestelltAm, erwartet_am: erwartetAm, ziel, status,
    lieferant: textOderNull(args.lieferant), referenz: textOderNull(args.referenz), notiz: textOderNull(args.notiz, 1000),
    created_by: userId,
  }).select("id").single();
  if (error) throw new Error(`bestellungen insert: ${error.message}`);
  return { ok: true, id: String(data.id) };
}

/** Menge, Termine, Ziel, Texte einer Bestellung aendern (z. B. Verzoegerung). */
export async function aendereBestellung(
  supabase: any, tenant_id: string, args: Record<string, unknown>,
): Promise<{ ok: true }> {
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error("id fehlt.");
  const satz: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("menge" in args) {
    const m = pruefeGanzzahl(args.menge, "Menge", 1, 1_000_000);
    if (m == null) throw new Error("Menge fehlt.");
    satz.menge = m;
  }
  if ("bestellt_am" in args) satz.bestellt_am = pruefeDatum(args.bestellt_am, "Bestellt am");
  if ("erwartet_am" in args) satz.erwartet_am = pruefeDatum(args.erwartet_am, "Erwartet am");
  if ("ziel" in args) satz.ziel = args.ziel === "lager" ? "lager" : "fba";
  if ("lieferant" in args) satz.lieferant = textOderNull(args.lieferant);
  if ("referenz" in args) satz.referenz = textOderNull(args.referenz);
  if ("notiz" in args) satz.notiz = textOderNull(args.notiz, 1000);
  const { error } = await supabase.from("bestellungen").update(satz).eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`bestellungen update: ${error.message}`);
  return { ok: true };
}

export async function setzeBestellungStatus(
  supabase: any, tenant_id: string, id: string, status: string,
): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt.");
  if (!(BESTELL_STATUS as readonly string[]).includes(status)) {
    throw new Error(`Status: erlaubt sind ${BESTELL_STATUS.join(", ")}.`);
  }
  const satz: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  // Eingetroffen bekommt ein Datum; zurueck auf offen loescht es wieder.
  satz.eingetroffen_am = status === "eingetroffen" ? new Date().toISOString().slice(0, 10) : null;
  const { error } = await supabase.from("bestellungen").update(satz).eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`bestellungen status: ${error.message}`);
  return { ok: true };
}

export async function loescheBestellung(supabase: any, tenant_id: string, id: string): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt.");
  const { error } = await supabase.from("bestellungen").delete().eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`bestellungen delete: ${error.message}`);
  return { ok: true };
}

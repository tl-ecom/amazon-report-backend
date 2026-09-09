// bestand_gesamt.ts — EINE Bestandslogik je ASIN ueber alle Quellen.
//
// Amazon (SP-API) kennt: FBA verfuegbar, FBA reserviert, Inbound zu Amazon.
// Sellerboard (Feed) kennt zusaetzlich: eigenes Lager, Prep Center, 3PL,
// bestellte Ware, AWD, sonstige Pipeline — und oft auch noch einmal FBA.
//
// Die Regel gegen Doppelzaehlung ist einfach und steht an genau einer Stelle:
// Sobald Amazon fuer den Mandanten Bestandsdaten liefert, ist Amazon fuer ALLES
// der Klasse „amazon" die einzige Quelle. Sellerboard-Zeilen dieser Klasse
// werden dann nicht gezaehlt, aber ausgewiesen (`doppelt_uebersprungen`), damit
// sichtbar bleibt, dass der Feed sie enthielt. Erst wenn Amazon GAR NICHTS
// liefert, fuellt Sellerboard die FBA-Spalten — gekennzeichnet mit Quelle.
//
// Zwei Summen, bewusst getrennt (siehe Aufgabe):
//   physisch_gesamt   = FBA verfuegbar + FBA reserviert + extern physisch
//                       (eigenes Lager, Prep Center, 3PL) — das ist greifbar.
//   pipeline_gesamt   = Amazon Inbound + bestellt + AWD/sonstige Pipeline —
//                       das kommt noch.
//   versorgung_gesamt = physisch + pipeline.
//
// Beispiel aus der Aufgabe: FBA 820, Logistiker 1.350, bestellt 2.000 ->
// physisch 2.170, Versorgung 4.170.
//
// Die Ableitungen sind rein (testbar); die DB-Schicht steht unten.

import { KLASSE, type Klasse, type Lagerart } from "./sellerboard_bestand.ts";

export interface AmazonBestand {
  asin: string;
  /** Verkaufsfaehig (bestand_je_asin). null = Amazon nennt nichts. */
  verfuegbar: number | null;
  /** Reserviert (nur aus fba_bestand; beim Planungsreport unbekannt). */
  reserviert: number | null;
  /** Inbound zu Amazon: shipped + working + receiving. null = Quelle kennt ihn nicht. */
  inbound: number | null;
  stand: string | null;
  /** 'myi' = FBA-Lagerbericht, 'planung' = Ersatzquelle. */
  quelle: string;
}

export interface ExternBestand {
  asin: string | null;
  sku: string | null;
  lagerart: Lagerart;
  lagername: string;
  menge: number | null;
  quelle: string;            // 'sellerboard'
  stand: string;
  marketplace_id: string | null;
}

export interface Ort {
  lagerart: Lagerart;
  klasse: Klasse;
  lagername: string;
  menge: number;
  quelle: string;
  stand: string | null;
}

export interface AsinBestand {
  asin: string;
  skus: string[];
  fba_verfuegbar: number | null;
  fba_reserviert: number | null;
  amazon_inbound: number | null;
  extern_physisch: number;
  ordered: number;
  /** AWD + sonstige Pipeline (in transit zwischen Lieferant und Lager usw.). */
  pipeline_sonstig: number;
  physisch_gesamt: number;
  pipeline_gesamt: number;
  versorgung_gesamt: number;
  orte: Ort[];
  quellen: string[];
  /** Sellerboard-Zeilen der Amazon-Klasse, die wegen SP-API-Daten NICHT gezaehlt wurden. */
  doppelt_uebersprungen: Array<{ lagerart: Lagerart; lagername: string; menge: number }>;
  stand_amazon: string | null;
  stand_extern: string | null;
  /** Woher die FBA-Zahlen stammen: 'amazon' oder — nur ohne SP-API-Daten — 'sellerboard'. */
  fba_quelle: "amazon" | "sellerboard" | null;
}

export interface VereinigungsErgebnis {
  zeilen: AsinBestand[];
  amazon_vorhanden: boolean;
  extern_vorhanden: boolean;
  stand_amazon: string | null;
  stand_extern: string | null;
  /** Extern-Zeilen ohne ASIN (SKU unbekannt) — nicht zuordenbar, nicht gezaehlt. */
  nicht_zuordenbar: Array<{ sku: string | null; lagerart: Lagerart; lagername: string; menge: number | null }>;
  summen: {
    fba_verfuegbar: number; fba_reserviert: number; amazon_inbound: number;
    extern_physisch: number; ordered: number; pipeline_sonstig: number;
    physisch_gesamt: number; pipeline_gesamt: number; versorgung_gesamt: number;
    doppelt_uebersprungen: number;
  };
}

const nz = (x: unknown): number => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a > b ? a : b));

/**
 * Amazon-Zeilen (eine je ASIN) und Extern-Zeilen (viele je ASIN) zu EINER
 * Sicht je ASIN zusammenfuehren. Rein, ohne Datenbank.
 */
export function vereinigeBestand(amazon: AmazonBestand[], extern: ExternBestand[]): VereinigungsErgebnis {
  const amazonVorhanden = amazon.length > 0;
  const proAsin = new Map<string, AsinBestand>();
  const nichtZuordenbar: VereinigungsErgebnis["nicht_zuordenbar"] = [];

  const hole = (asin: string): AsinBestand => {
    let z = proAsin.get(asin);
    if (!z) {
      z = {
        asin, skus: [], fba_verfuegbar: null, fba_reserviert: null, amazon_inbound: null,
        extern_physisch: 0, ordered: 0, pipeline_sonstig: 0,
        physisch_gesamt: 0, pipeline_gesamt: 0, versorgung_gesamt: 0,
        orte: [], quellen: [], doppelt_uebersprungen: [], stand_amazon: null, stand_extern: null, fba_quelle: null,
      };
      proAsin.set(asin, z);
    }
    return z;
  };

  let standAmazon: string | null = null;
  for (const a of amazon) {
    const z = hole(a.asin);
    z.fba_verfuegbar = a.verfuegbar;
    z.fba_reserviert = a.reserviert;
    z.amazon_inbound = a.inbound;
    z.stand_amazon = a.stand;
    z.fba_quelle = "amazon";
    if (!z.quellen.includes("amazon")) z.quellen.push("amazon");
    standAmazon = maxIso(standAmazon, a.stand);
    if (a.verfuegbar != null) z.orte.push({ lagerart: "fba_verfuegbar", klasse: "amazon", lagername: a.quelle === "planung" ? "FBA (Planungsreport)" : "FBA", menge: a.verfuegbar, quelle: "amazon", stand: a.stand });
    if (a.reserviert != null) z.orte.push({ lagerart: "fba_reserviert", klasse: "amazon", lagername: "FBA reserviert", menge: a.reserviert, quelle: "amazon", stand: a.stand });
    if (a.inbound != null) z.orte.push({ lagerart: "inbound_fba", klasse: "amazon", lagername: "Inbound zu Amazon", menge: a.inbound, quelle: "amazon", stand: a.stand });
  }

  let standExtern: string | null = null;
  for (const e of extern) {
    if (!e.asin) {
      nichtZuordenbar.push({ sku: e.sku, lagerart: e.lagerart, lagername: e.lagername, menge: e.menge });
      continue;
    }
    const z = hole(e.asin);
    if (e.sku && !z.skus.includes(e.sku)) z.skus.push(e.sku);
    if (!z.quellen.includes(e.quelle)) z.quellen.push(e.quelle);
    z.stand_extern = maxIso(z.stand_extern, e.stand);
    standExtern = maxIso(standExtern, e.stand);
    if (e.menge == null) continue; // unbekannt zaehlt nicht — und wird nicht zu 0

    const klasse = KLASSE[e.lagerart];
    if (klasse === "amazon") {
      if (amazonVorhanden) {
        // Amazon ist da -> Sellerboard-FBA nicht zaehlen, aber zeigen.
        z.doppelt_uebersprungen.push({ lagerart: e.lagerart, lagername: e.lagername, menge: e.menge });
        continue;
      }
      // Kein Amazon -> Sellerboard fuellt die FBA-Spalten, klar gekennzeichnet.
      z.fba_quelle = "sellerboard";
      if (e.lagerart === "fba_verfuegbar") z.fba_verfuegbar = nz(z.fba_verfuegbar) + e.menge;
      else if (e.lagerart === "fba_reserviert") z.fba_reserviert = nz(z.fba_reserviert) + e.menge;
      else if (e.lagerart === "inbound_fba") z.amazon_inbound = nz(z.amazon_inbound) + e.menge;
      // fba_unverkaeuflich: weder physisch verkaufsfaehig noch Pipeline — nur als Ort gefuehrt.
      z.orte.push({ lagerart: e.lagerart, klasse, lagername: e.lagername, menge: e.menge, quelle: e.quelle, stand: e.stand });
      continue;
    }
    if (klasse === "physisch_extern") z.extern_physisch += e.menge;
    else if (e.lagerart === "ordered") z.ordered += e.menge;
    else z.pipeline_sonstig += e.menge;
    z.orte.push({ lagerart: e.lagerart, klasse, lagername: e.lagername, menge: e.menge, quelle: e.quelle, stand: e.stand });
  }

  const zeilen = [...proAsin.values()];
  for (const z of zeilen) {
    z.physisch_gesamt = nz(z.fba_verfuegbar) + nz(z.fba_reserviert) + z.extern_physisch;
    z.pipeline_gesamt = nz(z.amazon_inbound) + z.ordered + z.pipeline_sonstig;
    z.versorgung_gesamt = z.physisch_gesamt + z.pipeline_gesamt;
    z.skus.sort();
  }
  zeilen.sort((a, b) => b.versorgung_gesamt - a.versorgung_gesamt || a.asin.localeCompare(b.asin));

  const sum = (f: (z: AsinBestand) => number) => zeilen.reduce((s, z) => s + f(z), 0);
  return {
    zeilen,
    amazon_vorhanden: amazonVorhanden,
    extern_vorhanden: extern.length > 0,
    stand_amazon: standAmazon,
    stand_extern: standExtern,
    nicht_zuordenbar: nichtZuordenbar,
    summen: {
      fba_verfuegbar: sum((z) => nz(z.fba_verfuegbar)),
      fba_reserviert: sum((z) => nz(z.fba_reserviert)),
      amazon_inbound: sum((z) => nz(z.amazon_inbound)),
      extern_physisch: sum((z) => z.extern_physisch),
      ordered: sum((z) => z.ordered),
      pipeline_sonstig: sum((z) => z.pipeline_sonstig),
      physisch_gesamt: sum((z) => z.physisch_gesamt),
      pipeline_gesamt: sum((z) => z.pipeline_gesamt),
      versorgung_gesamt: sum((z) => z.versorgung_gesamt),
      doppelt_uebersprungen: sum((z) => z.doppelt_uebersprungen.reduce((s, d) => s + d.menge, 0)),
    },
  };
}

// --- Kapitalbindung ---------------------------------------------------------

export interface KapitalZeile extends AsinBestand {
  produktname: string;
  ek_cents: number | null;
  /** Stueck je Tag aus den Bestellungen (90 Tage). null = keine Verkaufsbasis. */
  velo_tag: number | null;
  reichweite_fba_tage: number | null;
  /** Reichweite auf den physischen Gesamtbestand (FBA + extern). */
  reichweite_physisch_tage: number | null;
  /** Reichweite auf die gesamte Versorgung (inkl. bestellt/unterwegs). */
  reichweite_versorgung_tage: number | null;
  wert_fba_cents: number | null;
  wert_extern_cents: number | null;
  wert_ordered_cents: number | null;
  wert_inbound_cents: number | null;
  wert_pipeline_sonstig_cents: number | null;
}

export interface Kapitalbindung {
  waehrung: "EUR";
  /** Anteil der Einheiten (physisch + pipeline), fuer die ein EK bekannt ist. 0..1 */
  ek_abdeckung: number;
  einheiten: {
    fba: number; extern: number; ordered: number; inbound: number; pipeline_sonstig: number;
    physisch: number; pipeline: number; versorgung: number;
  };
  /** Werte zum EK. null = fuer keine einzige Einheit ein EK bekannt. */
  wert_cents: {
    fba: number | null; extern: number | null; ordered: number | null; inbound: number | null;
    pipeline_sonstig: number | null;
    /** Eigenes Lager + Prep + 3PL + bestellt + sonstige Pipeline: alles, was nicht bei Amazon liegt. */
    ausserhalb_amazon: number | null;
    physisch: number | null;
    gesamt: number | null;
  };
  /** Tage bis leer auf Kontoebene: Summe Bestand / Summe Velocity. */
  reichweite_tage: { fba: number | null; physisch: number | null; versorgung: number | null };
  hinweise: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Bestand je ASIN mit EK und Velocity bewerten. Rein. Fehlender EK ergibt null,
 * nie 0 — und senkt die ausgewiesene EK-Abdeckung.
 */
export function bewerteKapital(
  zeilen: AsinBestand[],
  ek: Map<string, number>,
  velo: Map<string, number>,
  titel: Map<string, string> = new Map(),
): { zeilen: KapitalZeile[]; kapital: Kapitalbindung } {
  const wert = (menge: number | null, ekC: number | null) => (menge == null || ekC == null ? null : menge * ekC);
  const rw = (menge: number | null, v: number | null) =>
    menge == null || v == null || v <= 0 ? null : r1(menge / v);

  const kz: KapitalZeile[] = zeilen.map((z) => {
    const ekC = ek.get(z.asin) ?? null;
    const v = velo.get(z.asin) ?? null;
    return {
      ...z,
      produktname: titel.get(z.asin) ?? z.asin,
      ek_cents: ekC,
      velo_tag: v,
      reichweite_fba_tage: rw(z.fba_verfuegbar, v),
      reichweite_physisch_tage: rw(z.physisch_gesamt, v),
      reichweite_versorgung_tage: rw(z.versorgung_gesamt, v),
      wert_fba_cents: wert(z.fba_verfuegbar == null && z.fba_reserviert == null ? null : nz(z.fba_verfuegbar) + nz(z.fba_reserviert), ekC),
      wert_extern_cents: wert(z.extern_physisch, ekC),
      wert_ordered_cents: wert(z.ordered, ekC),
      wert_inbound_cents: wert(z.amazon_inbound, ekC),
      wert_pipeline_sonstig_cents: wert(z.pipeline_sonstig, ekC),
    };
  });

  const summeOderNull = (f: (z: KapitalZeile) => number | null): number | null => {
    let s = 0, gesehen = false;
    for (const z of kz) { const w = f(z); if (w != null) { s += w; gesehen = true; } }
    return gesehen ? s : null;
  };
  const plus = (...xs: Array<number | null>): number | null =>
    xs.every((x) => x == null) ? null : xs.reduce<number>((s, x) => s + nz(x), 0);

  const einheiten = {
    fba: kz.reduce((s, z) => s + nz(z.fba_verfuegbar) + nz(z.fba_reserviert), 0),
    extern: kz.reduce((s, z) => s + z.extern_physisch, 0),
    ordered: kz.reduce((s, z) => s + z.ordered, 0),
    inbound: kz.reduce((s, z) => s + nz(z.amazon_inbound), 0),
    pipeline_sonstig: kz.reduce((s, z) => s + z.pipeline_sonstig, 0),
    physisch: 0, pipeline: 0, versorgung: 0,
  };
  einheiten.physisch = einheiten.fba + einheiten.extern;
  einheiten.pipeline = einheiten.inbound + einheiten.ordered + einheiten.pipeline_sonstig;
  einheiten.versorgung = einheiten.physisch + einheiten.pipeline;

  const mitEk = kz.filter((z) => z.ek_cents != null).reduce((s, z) => s + z.versorgung_gesamt, 0);
  const abdeckung = einheiten.versorgung > 0 ? mitEk / einheiten.versorgung : 0;

  const wFba = summeOderNull((z) => z.wert_fba_cents);
  const wExt = summeOderNull((z) => z.wert_extern_cents);
  const wOrd = summeOderNull((z) => z.wert_ordered_cents);
  const wInb = summeOderNull((z) => z.wert_inbound_cents);
  const wSon = summeOderNull((z) => z.wert_pipeline_sonstig_cents);

  // Velocity nur ueber ASINs summieren, die auch Bestand haben — sonst driftet
  // die Kontoreichweite durch Produkte, die nur noch verkauft, aber nicht mehr
  // gelagert werden.
  const veloSumme = kz.reduce((s, z) => s + (z.velo_tag ?? 0), 0);
  const reichweite = (menge: number) => (veloSumme > 0 ? r1(menge / veloSumme) : null);

  const hinweise: string[] = [];
  if (einheiten.versorgung > 0 && abdeckung < 0.999) {
    hinweise.push(
      `Für ${Math.round((1 - abdeckung) * 100)} % der Einheiten ist kein Einkaufspreis hinterlegt — die Werte sind entsprechend zu niedrig, nicht null.`,
    );
  }
  if (veloSumme <= 0) hinweise.push("Keine Verkaufsgeschwindigkeit messbar — Reichweiten bleiben leer.");

  return {
    zeilen: kz,
    kapital: {
      waehrung: "EUR",
      ek_abdeckung: abdeckung,
      einheiten,
      wert_cents: {
        fba: wFba, extern: wExt, ordered: wOrd, inbound: wInb, pipeline_sonstig: wSon,
        ausserhalb_amazon: plus(wExt, wOrd, wSon),
        physisch: plus(wFba, wExt),
        gesamt: plus(wFba, wExt, wOrd, wInb, wSon),
      },
      reichweite_tage: {
        fba: reichweite(kz.reduce((s, z) => s + nz(z.fba_verfuegbar), 0)),
        physisch: reichweite(einheiten.physisch),
        versorgung: reichweite(einheiten.versorgung),
      },
      hinweise,
    },
  };
}

// --- DB-Schicht --------------------------------------------------------------

/** Aktuelle Extern-Bestaende eines Mandanten (alle Quellen). */
export async function ladeExternBestand(supabase: any, tenant_id: string): Promise<ExternBestand[]> {
  const { data, error } = await supabase.from("bestand_extern")
    .select("asin, sku, lagerart, lagername, menge, quelle, stand, marketplace_id")
    .eq("tenant_id", tenant_id);
  if (error) throw new Error(`bestand_extern: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    asin: r.asin ? String(r.asin) : null,
    sku: r.sku ? String(r.sku) : null,
    lagerart: r.lagerart as Lagerart,
    lagername: String(r.lagername ?? ""),
    menge: r.menge == null ? null : Number(r.menge),
    quelle: String(r.quelle ?? "sellerboard"),
    stand: String(r.stand ?? ""),
    marketplace_id: r.marketplace_id ?? null,
  }));
}

export interface ExternJeAsin {
  extern_physisch: number;
  ordered: number;
  pipeline_sonstig: number;
  stand: string | null;
  quelle: string | null;
}

/**
 * Kompakte Sicht fuer Nachschub/Ladenhueter/Historie: je ASIN die externen
 * Mengen nach Klasse. Amazon-Klasse aus Sellerboard wird hier NIE mitgezaehlt —
 * diese Module holen FBA ohnehin aus der SP-API.
 * Leere Map, wenn der Mandant keine externe Quelle hat.
 */
export async function externJeAsin(supabase: any, tenant_id: string): Promise<Map<string, ExternJeAsin>> {
  const map = new Map<string, ExternJeAsin>();
  let extern: ExternBestand[];
  try { extern = await ladeExternBestand(supabase, tenant_id); } catch { return map; }
  for (const e of extern) {
    if (!e.asin || e.menge == null) continue;
    const k = KLASSE[e.lagerart];
    if (k === "amazon") continue;
    const z = map.get(e.asin) ?? { extern_physisch: 0, ordered: 0, pipeline_sonstig: 0, stand: null, quelle: null };
    if (k === "physisch_extern") z.extern_physisch += e.menge;
    else if (e.lagerart === "ordered") z.ordered += e.menge;
    else z.pipeline_sonstig += e.menge;
    z.stand = maxIso(z.stand, e.stand);
    z.quelle = e.quelle;
    map.set(e.asin, z);
  }
  return map;
}

/** Amazon-Bestand je ASIN: frischere Quelle (bestand_je_asin) + reserviert aus fba_bestand. */
export async function ladeAmazonBestand(supabase: any, tenant_id: string): Promise<AmazonBestand[]> {
  const [jeAsin, fba] = await Promise.all([
    supabase.rpc("bestand_je_asin", { p_tenant: tenant_id }),
    supabase.from("fba_bestand").select("asin, reserviert").eq("tenant_id", tenant_id).not("asin", "is", null),
  ]);
  if (jeAsin.error) throw new Error(`bestand_je_asin: ${jeAsin.error.message}`);
  const reserviert = new Map<string, number | null>();
  for (const r of (fba.data ?? []) as any[]) {
    const a = String(r.asin);
    if (r.reserviert == null) { if (!reserviert.has(a)) reserviert.set(a, null); continue; }
    reserviert.set(a, nz(reserviert.get(a)) + Number(r.reserviert));
  }
  return ((jeAsin.data ?? []) as any[]).map((r) => ({
    asin: String(r.asin),
    verfuegbar: r.bestand == null ? null : Number(r.bestand),
    // Der Planungsreport kennt keine Reservierungen -> unbekannt, nicht 0.
    reserviert: r.quelle === "planung" ? null : (reserviert.get(String(r.asin)) ?? null),
    inbound: r.unterwegs == null ? null : Number(r.unterwegs),
    stand: r.stand ?? null,
    quelle: String(r.quelle ?? "myi"),
  }));
}

/** Juengster EK je ASIN (gueltig_ab <= heute), in Cent. */
export async function ladeEkJeAsin(supabase: any, tenant_id: string): Promise<Map<string, number>> {
  const heute = new Date().toISOString().slice(0, 10);
  const { data } = await supabase.from("asin_ek").select("asin, ek_cents, gueltig_ab")
    .eq("tenant_id", tenant_id).lte("gueltig_ab", heute).order("gueltig_ab", { ascending: false });
  const map = new Map<string, number>();
  for (const r of (data ?? []) as any[]) {
    const a = String(r.asin);
    if (!map.has(a)) map.set(a, Number(r.ek_cents));
  }
  return map;
}

export const VELO_FENSTER_TAGE = 90;

/**
 * Gesamtbestand je ASIN inkl. Kapitalbindung. Das ist die Ressource
 * `bestand_gesamt` fuer Web und KI und liefert auch den Block fuer den Cash-Flow.
 */
export async function bestandGesamt(supabase: any, tenant_id: string): Promise<unknown> {
  const [amazon, extern, ek, veloRes, asinRes, verbRes] = await Promise.all([
    ladeAmazonBestand(supabase, tenant_id),
    ladeExternBestand(supabase, tenant_id),
    ladeEkJeAsin(supabase, tenant_id),
    supabase.rpc("stockout_basis", { p_tenant: tenant_id, p_tage: VELO_FENSTER_TAGE }),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
    supabase.from("bestand_verbindungen").select("quelle, status, zuletzt_erfolg, zuletzt_versuch, letzter_fehler")
      .eq("tenant_id", tenant_id),
  ]);

  const velo = new Map<string, number>();
  for (const r of (veloRes.data ?? []) as any[]) velo.set(String(r.asin), nz(r.velo_tag));
  const titel = new Map<string, string>(
    ((asinRes.data ?? []) as any[]).map((a) => [String(a.asin), String(a.produktname ?? a.asin)]),
  );

  const v = vereinigeBestand(amazon, extern);
  const { zeilen, kapital } = bewerteKapital(v.zeilen, ek, velo, titel);

  const hinweise: string[] = [...kapital.hinweise];
  if (!v.amazon_vorhanden && !v.extern_vorhanden) {
    hinweise.push("Weder Amazon noch eine externe Quelle liefern Bestandsdaten.");
  }
  if (!v.amazon_vorhanden && v.extern_vorhanden) {
    hinweise.push("Amazon liefert keinen FBA-Bestand — die FBA-Spalten stammen aus Sellerboard und sind entsprechend gekennzeichnet.");
  }
  if (v.summen.doppelt_uebersprungen > 0) {
    hinweise.push(
      `${v.summen.doppelt_uebersprungen} Einheiten FBA/Inbound aus Sellerboard wurden nicht gezählt, weil Amazon dafür die primäre Quelle ist (keine Doppelzählung).`,
    );
  }
  if (v.nicht_zuordenbar.length > 0) {
    hinweise.push(`${v.nicht_zuordenbar.length} externe Bestandszeile(n) ohne zuordenbare ASIN werden nicht gezählt.`);
  }

  return {
    stand_amazon: v.stand_amazon,
    stand_extern: v.stand_extern,
    amazon_vorhanden: v.amazon_vorhanden,
    extern_vorhanden: v.extern_vorhanden,
    quellen: ((verbRes.data ?? []) as any[]).map((r) => ({
      quelle: r.quelle, status: r.status, zuletzt_erfolg: r.zuletzt_erfolg ?? null,
      zuletzt_versuch: r.zuletzt_versuch ?? null, letzter_fehler: r.letzter_fehler ?? null,
    })),
    summen: v.summen,
    kapital,
    velo_fenster_tage: VELO_FENSTER_TAGE,
    nicht_zuordenbar: v.nicht_zuordenbar.slice(0, 50),
    zeilen,
    hinweise,
  };
}

/**
 * Nur der Kapitalblock — fuer den Cash-Flow. Faengt Fehler ab: fehlt die
 * Grundlage, bleibt der Block null statt die ganze Cash-Sicht zu reissen.
 */
export async function kapitalbindung(supabase: any, tenant_id: string): Promise<Kapitalbindung | null> {
  try {
    const [amazon, extern, ek, veloRes] = await Promise.all([
      ladeAmazonBestand(supabase, tenant_id),
      ladeExternBestand(supabase, tenant_id),
      ladeEkJeAsin(supabase, tenant_id),
      supabase.rpc("stockout_basis", { p_tenant: tenant_id, p_tage: VELO_FENSTER_TAGE }),
    ]);
    if (amazon.length === 0 && extern.length === 0) return null;
    const velo = new Map<string, number>();
    for (const r of (veloRes.data ?? []) as any[]) velo.set(String(r.asin), nz(r.velo_tag));
    return bewerteKapital(vereinigeBestand(amazon, extern).zeilen, ek, velo).kapital;
  } catch {
    return null;
  }
}

// overview.ts — Pulse Overview (Modul 1): "Was passiert gerade im Account?"
// Kombiniert die vorhandenen Aggregatoren (Sales & Traffic, Listings) + die
// jüngsten Change Events zu einer entscheidungsfokussierten Übersicht:
// Ampel-Status, Top-KPIs, max. 3 priorisierte Prüfungen, auffällige ASINs.
//
// Dazu die Bewegung: letzte 30 Tage gegen die 30 Tage davor — Umsatz und
// Ertrag gesamt, und je Produkt die drei größten Gewinner und Verlierer.
// Eine Übersicht, die nur den Stand zeigt, beantwortet die eigentliche
// Frage nicht: was hat sich bewegt, und wo?
//
// Die Hinweis-Ableitung (baueHinweise), die Ampel (ampelStatus) und die
// Bewegungs-Rangliste (baueBewegungen) sind rein und unit-getestet. Sie
// behaupten KEINE Ursache — sie benennen Prüf-Kandidaten.

import { baueOverview } from "./metrics.ts";
import { baueListingsOverview } from "./listings.ts";
import { produktUebersicht } from "./produkte.ts";

const SALES_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";
const LISTINGS_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const SESSIONS_MIN = 30; // Schwelle, ab der "Traffic" als aussagekräftig gilt

/** Vergleichsfenster für die Bewegung: 30 Tage gegen die 30 davor. */
export const BEWEGUNG_TAGE = 30;
/** Produkte unter dieser Umsatzbasis (in beiden Fenstern) bleiben aus der
 *  Rangliste: +300 % auf 12 € sind Rauschen, kein Gewinner. */
export const BEWEGUNG_MIN_UMSATZ = 50;
/** Produkttitel in Listen: abgekürzt, damit die Zeile lesbar bleibt. */
export const TITEL_MAX = 85;

export interface Hinweis {
  typ: string;
  prioritaet: "kritisch" | "hoch" | "mittel" | "niedrig";
  text: string;
  asin?: string;
  produktname?: string | null;
}

const PRIO_RANG: Record<Hinweis["prioritaet"], number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 };

/** Titel auf TITEL_MAX Zeichen kürzen — am Wortende, mit Auslassungszeichen. */
export function kuerzeTitel(titel: unknown, max = TITEL_MAX): string | null {
  const t = typeof titel === "string" ? titel.trim().replace(/\s+/g, " ") : "";
  if (!t) return null;
  if (t.length <= max) return t;
  const schnitt = t.slice(0, max - 1);
  const leer = schnitt.lastIndexOf(" ");
  return (leer > max * 0.6 ? schnitt.slice(0, leer) : schnitt).trimEnd() + "…";
}

/** Leitet aus Sales-Overview + Listings-Overview deterministische Prüf-Hinweise ab. */
export function baueHinweise(sales: any, listings: any): Hinweis[] {
  const hinweise: Hinweis[] = [];
  const accCvr: number | null = sales?.gesamt?.cvrUnitSession ?? null;
  const proAsin: any[] = sales?.proAsin ?? [];

  const top = proAsin[0];
  if (top && top.umsatzAnteil != null && top.umsatzAnteil > 50) {
    hinweise.push({ typ: "umsatzkonzentration", prioritaet: "mittel", asin: top.childAsin, text: `Der Umsatz hängt stark an einer ASIN (${top.childAsin}: ${top.umsatzAnteil} %).` });
  }

  for (const a of proAsin) {
    const sessions = Number(a.sessions) || 0;
    const units = Number(a.unitsOrdered) || 0;
    const cvr = a.cvrUnitSession;
    if (sessions >= SESSIONS_MIN && units === 0) {
      hinweise.push({ typ: "traffic_ohne_verkauf", prioritaet: "hoch", asin: a.childAsin, text: `${a.childAsin}: ${sessions} Sessions, aber 0 Verkäufe.` });
    } else if (accCvr && sessions >= SESSIONS_MIN && cvr != null && cvr < accCvr * 0.5) {
      hinweise.push({ typ: "conversion_unter_schnitt", prioritaet: "mittel", asin: a.childAsin, text: `${a.childAsin}: CVR ${cvr} % — deutlich unter Account-Schnitt (${accCvr} %).` });
    }
    if (accCvr && cvr != null && cvr > accCvr && sessions > 0 && sessions < SESSIONS_MIN) {
      hinweise.push({ typ: "gute_cvr_wenig_traffic", prioritaet: "niedrig", asin: a.childAsin, text: `${a.childAsin}: gute CVR (${cvr} %) bei wenig Traffic (${sessions} Sessions) — Potenzial für mehr Reichweite.` });
    }
  }

  const ausverkauft = Number(listings?.bestand_merchant?.ausverkauft) || 0;
  if (ausverkauft > 0) {
    hinweise.push({ typ: "fbm_ohne_bestand", prioritaet: "kritisch", text: `${ausverkauft} aktive Merchant-Angebote ohne Bestand — live, aber nicht verkaufsfähig.` });
  }

  return hinweise.sort((a, b) => PRIO_RANG[a.prioritaet] - PRIO_RANG[b.prioritaet]);
}

/** Ampel aus den Hinweisen: kritisch→rot, hoch/mittel→gelb, sonst grün. */
export function ampelStatus(hinweise: Hinweis[]): "rot" | "gelb" | "gruen" {
  if (hinweise.some((h) => h.prioritaet === "kritisch")) return "rot";
  if (hinweise.some((h) => h.prioritaet === "hoch" || h.prioritaet === "mittel")) return "gelb";
  return "gruen";
}

// --- Bewegung: 30 Tage gegen die 30 davor ---

export interface BewegungProdukt {
  asin: string;
  produktname: string | null;
  umsatz: number;
  umsatz_vorher: number;
  umsatz_delta: number;
  umsatz_delta_prozent: number | null;
  /** Deckungsbeitrag nach Werbung — null, wenn EK oder Gebühren fehlen. */
  ertrag: number | null;
  ertrag_vorher: number | null;
  ertrag_delta: number | null;
  nettomarge: number | null;
  nettomarge_vorher: number | null;
}

export interface Bewegung {
  zeitraum: { von: string; bis: string };
  vergleich: { von: string; bis: string };
  gesamt: {
    umsatz: number; umsatz_vorher: number; umsatz_delta_prozent: number | null;
    ertrag: number | null; ertrag_vorher: number | null; ertrag_delta_prozent: number | null;
    produkte_mit_ertrag: number; produkte: number;
    /** Umsatzgewichteter Anteil der Bestellungen, die Amazon schon abgerechnet
     *  hat. Ohne ihn ist der Ertrag oben nicht lesbar. */
    gebuehren_abdeckung: number | null;
  };
  umsatz: { gewinner: BewegungProdukt[]; verlierer: BewegungProdukt[] };
  ertrag: { gewinner: BewegungProdukt[]; verlierer: BewegungProdukt[] };
  hinweise: string[];
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

function deltaProzent(jetzt: number, vorher: number): number | null {
  if (!Number.isFinite(vorher) || vorher === 0) return null;
  return Math.round(((jetzt - vorher) / Math.abs(vorher)) * 1000) / 10;
}

interface ProduktZeile {
  asin: string; produktname?: string | null; umsatz: number;
  nettogewinn: number | null; nettomarge: number | null;
}

/**
 * Gewinner und Verlierer aus zwei Produkt-Übersichten. Sortiert nach der
 * Veränderung in EURO, nicht in Prozent: ein Produkt, das 2.000 € dazugewinnt,
 * bewegt das Konto — eines, das von 10 auf 40 € geht, nicht. Der Prozentwert
 * steht daneben. Produkte, die in beiden Fenstern unter BEWEGUNG_MIN_UMSATZ
 * liegen, bleiben draußen.
 *
 * Ertrag nur, wo er in BEIDEN Fenstern bekannt ist (EK und Gebühren). Sonst
 * verglichen wir eine Zahl mit einer Lücke.
 */
export function baueBewegungen(
  aktuell: ProduktZeile[],
  vorher: ProduktZeile[],
  zeitraum: { von: string; bis: string },
  vergleich: { von: string; bis: string },
  titel: Map<string, string | null> = new Map(),
  top = 3,
): Bewegung {
  const vorherMap = new Map(vorher.map((p) => [p.asin, p]));
  const asins = new Set<string>([...aktuell.map((p) => p.asin), ...vorher.map((p) => p.asin)]);

  const zeilen: BewegungProdukt[] = [];
  for (const asin of asins) {
    const a = aktuell.find((p) => p.asin === asin);
    const v = vorherMap.get(asin);
    const umsatz = r2(a?.umsatz ?? 0);
    const umsatzVorher = r2(v?.umsatz ?? 0);
    if (umsatz < BEWEGUNG_MIN_UMSATZ && umsatzVorher < BEWEGUNG_MIN_UMSATZ) continue;
    const ertrag = a?.nettogewinn ?? null;
    const ertragVorher = v?.nettogewinn ?? null;
    zeilen.push({
      asin,
      produktname: kuerzeTitel(titel.get(asin) ?? a?.produktname ?? v?.produktname ?? null),
      umsatz,
      umsatz_vorher: umsatzVorher,
      umsatz_delta: r2(umsatz - umsatzVorher),
      umsatz_delta_prozent: deltaProzent(umsatz, umsatzVorher),
      ertrag: ertrag == null ? null : r2(ertrag),
      ertrag_vorher: ertragVorher == null ? null : r2(ertragVorher),
      ertrag_delta: ertrag != null && ertragVorher != null ? r2(ertrag - ertragVorher) : null,
      nettomarge: a?.nettomarge ?? null,
      nettomarge_vorher: v?.nettomarge ?? null,
    });
  }

  const nachUmsatz = [...zeilen].sort((x, y) => y.umsatz_delta - x.umsatz_delta);
  const mitErtrag = zeilen.filter((z) => z.ertrag_delta != null);
  const nachErtrag = [...mitErtrag].sort((x, y) => y.ertrag_delta! - x.ertrag_delta!);

  const umsatzGesamt = r2(aktuell.reduce((s, p) => s + (p.umsatz || 0), 0));
  const umsatzVorherGesamt = r2(vorher.reduce((s, p) => s + (p.umsatz || 0), 0));
  const ertragBekannt = (l: ProduktZeile[]) => l.filter((p) => p.nettogewinn != null);
  const ertragGesamt = ertragBekannt(aktuell).length ? r2(ertragBekannt(aktuell).reduce((s, p) => s + p.nettogewinn!, 0)) : null;
  const ertragVorherGesamt = ertragBekannt(vorher).length ? r2(ertragBekannt(vorher).reduce((s, p) => s + p.nettogewinn!, 0)) : null;

  const hinweise: string[] = [];
  const ohneErtrag = aktuell.filter((p) => p.umsatz >= BEWEGUNG_MIN_UMSATZ && p.nettogewinn == null).length;
  if (ohneErtrag > 0) {
    hinweise.push(`${ohneErtrag} Produkt${ohneErtrag === 1 ? "" : "e"} ohne Ertragswert (Einkaufspreis oder Gebühren fehlen) — fehlt in der Ertrags-Rangliste und in der Ertragssumme.`);
  }
  if (zeilen.length === 0) hinweise.push("Kein Produkt über der Umsatzbasis in beiden Fenstern — noch keine Bewegung messbar.");

  return {
    zeitraum,
    vergleich,
    gesamt: {
      umsatz: umsatzGesamt,
      umsatz_vorher: umsatzVorherGesamt,
      umsatz_delta_prozent: deltaProzent(umsatzGesamt, umsatzVorherGesamt),
      ertrag: ertragGesamt,
      ertrag_vorher: ertragVorherGesamt,
      ertrag_delta_prozent: ertragGesamt != null && ertragVorherGesamt != null ? deltaProzent(ertragGesamt, ertragVorherGesamt) : null,
      produkte_mit_ertrag: ertragBekannt(aktuell).length,
      produkte: aktuell.length,
      /**
       * Anteil der Bestellungen im Fenster, die Amazon schon abgerechnet hat.
       *
       * Der Ertrag oben ist ohne diese Zahl nicht lesbar: Umsatz und Wareneinsatz
       * stehen sofort fest, die GEBUEHREN kommen mit Wochen Verzug. Bei 35 %
       * Abdeckung fehlen zwei Drittel der Gebuehren, und der Ertrag faellt um
       * ein Vielfaches zu hoch aus — bei Vaneja 28.046 € statt rund 16.000 €.
       */
      gebuehren_abdeckung: abdeckung(aktuell),
    },
    umsatz: {
      gewinner: nachUmsatz.filter((z) => z.umsatz_delta > 0).slice(0, top),
      verlierer: nachUmsatz.filter((z) => z.umsatz_delta < 0).reverse().slice(0, top),
    },
    ertrag: {
      gewinner: nachErtrag.filter((z) => z.ertrag_delta! > 0).slice(0, top),
      verlierer: nachErtrag.filter((z) => z.ertrag_delta! < 0).reverse().slice(0, top),
    },
    hinweise,
  };
}

// --- DB ---

async function ladeLatest(supabase: any, tenant_id: string, reportType: string): Promise<any | null> {
  const { data } = await supabase
    .from("report_data")
    .select("payload, data_timestamp, is_provisional")
    .eq("tenant_id", tenant_id).eq("source", "sp").eq("report_type", reportType).eq("is_latest", true)
    .maybeSingle();
  return data ?? null;
}

function tagVor(tage: number, ab: Date = new Date()): string {
  return new Date(ab.getTime() - tage * 86_400_000).toISOString().slice(0, 10);
}

/** Produkttitel je ASIN aus dem Katalog — eine Abfrage, ein Map. */
async function ladeTitel(supabase: any, tenant_id: string): Promise<Map<string, string | null>> {
  const { data } = await supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id);
  const m = new Map<string, string | null>();
  for (const r of data ?? []) m.set(String(r.asin), r.produktname ?? null);
  return m;
}

/**
 * Umsatzgewichtete Abrechnungsquote des Fensters.
 *
 * Bewusst gewichtet und nicht als Mittelwert ueber Produkte: ein kleines
 * Produkt mit einer einzigen abgerechneten Bestellung wuerde den Schnitt sonst
 * genauso stark heben wie der Umsatztraeger.
 */
function abdeckung(produkte: any[]): number | null {
  let umsatz = 0;
  let gedeckt = 0;
  for (const p of produkte) {
    const u = Number(p?.umsatz) || 0;
    const a = p?.gebuehren_abdeckung;
    if (u <= 0 || a === null || a === undefined) continue;
    umsatz += u;
    gedeckt += u * Number(a);
  }
  return umsatz > 0 ? Math.round((gedeckt / umsatz) * 1000) / 1000 : null;
}

export async function pulseOverview(supabase: any, tenant_id: string): Promise<unknown> {
  // Bewegungsfenster: gestern zurück, damit der angebrochene Tag nicht als
  // Einbruch erscheint.
  const bis = tagVor(1);
  const von = tagVor(BEWEGUNG_TAGE);
  const vBis = tagVor(BEWEGUNG_TAGE + 1);
  const vVon = tagVor(2 * BEWEGUNG_TAGE);

  const [salesRow, listingsRow, changesRes, titel, aktuell, vorher, adsRes, ertragRes, diagRes] = await Promise.all([
    ladeLatest(supabase, tenant_id, SALES_TYPE),
    ladeLatest(supabase, tenant_id, LISTINGS_TYPE),
    supabase.from("change_events").select("asin, event_type, previous_value, new_value, relevance, effective_at, status")
      .eq("tenant_id", tenant_id).order("detected_at", { ascending: false }).limit(5),
    ladeTitel(supabase, tenant_id),
    produktUebersicht(supabase, tenant_id, { von, bis }).catch(() => null) as Promise<any>,
    produktUebersicht(supabase, tenant_id, { von: vVon, bis: vBis }).catch(() => null) as Promise<any>,
    supabase.rpc("ads_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    // Ertrag ueber den juengsten KALENDERMONAT, der abgerechnet ist. Das
    // Bewegungsfenster taugt dafuer nicht: dort fehlen die Gebuehren noch.
    supabase.rpc("ertrag_abgerechnet", { p_tenant: tenant_id }),
    supabase.from("diagnoses").select("id", { count: "exact", head: true }).eq("tenant_id", tenant_id).eq("status", "offen"),
  ]);

  const sales = salesRow ? baueOverview(salesRow.payload, salesRow.data_timestamp, salesRow.is_provisional) as any : null;
  const listings = listingsRow ? baueListingsOverview(listingsRow.payload, listingsRow.data_timestamp) as any : null;

  const mitTitel = <T extends { asin?: string | null }>(x: T) => ({
    ...x,
    produktname: x.asin ? kuerzeTitel(titel.get(x.asin)) : null,
  });

  const hinweise = baueHinweise(sales, listings).map(mitTitel);
  const status = ampelStatus(hinweise);

  const bewegung = aktuell && vorher
    ? baueBewegungen(aktuell.produkte ?? [], vorher.produkte ?? [], { von, bis }, { von: vVon, bis: vBis }, titel)
    : null;

  // Werbung im Bewegungsfenster: Spend und TACOS (Werbung am Gesamtumsatz —
  // die ehrlichere Größe, weil organische Verkäufe die Werbung mittragen).
  const adsGesamt = ((adsRes?.data ?? []) as any[]).find((r) => r.ebene === "gesamt");
  const werbung = adsGesamt ? r2(Number(adsGesamt.spend_cents) / 100) : null;
  const tacos = werbung != null && bewegung && bewegung.gesamt.umsatz > 0
    ? Math.round((werbung / bewegung.gesamt.umsatz) * 1000) / 10
    : null;

  // Der ehrliche Ertrag: ein abgeschlossener Monat statt der letzten 30 Tage.
  // Umsatz und Wareneinsatz stehen sofort fest, die GEBUEHREN kommen mit Wochen
  // Verzug — im laufenden Fenster fehlen bei Vaneja rund 60 % davon, und der
  // Ertrag faellt dadurch um ein Vielfaches zu hoch aus.
  const eaRoh = ((ertragRes?.data ?? []) as any[])[0] ?? null;
  const ertragMonat = eaRoh
    ? {
      monat: String(eaRoh.monat),
      von: eaRoh.von, bis: eaRoh.bis,
      // BRUTTO — produkt_uebersicht.umsatz_cents ist identisch mit
      // orders_history.item_price_cents. Der Name sagt das jetzt auch: als
      // "netto" gelesen hat die Rechnung die Steuer nie abgezogen und das
      // Juli-Ergebnis um 8.821 € zu hoch ausgewiesen.
      umsatz_brutto: r2(Number(eaRoh.umsatz_brutto_cents) / 100),
      umsatzsteuer: r2(Number(eaRoh.umsatzsteuer_cents) / 100),
      wareneinsatz: r2(Number(eaRoh.wareneinsatz_cents) / 100),
      gebuehren: r2(Number(eaRoh.gebuehren_cents) / 100),
      werbung: r2(Number(eaRoh.werbung_cents) / 100),
      // Getrennt ausgewiesen und nicht mit dem Umsatz verrechnet: eine
      // Retourenquote ist eine Fuehrungsgroesse. Im Nettoumsatz versteckt
      // sieht man sie nie wieder.
      erstattungen: r2(Number(eaRoh.erstattungen_cents) / 100),
      ertrag: r2(Number(eaRoh.ertrag_cents) / 100),
      marge: Number(eaRoh.umsatz_brutto_cents) > 0
        ? Math.round((Number(eaRoh.ertrag_cents) / Number(eaRoh.umsatz_brutto_cents)) * 1000) / 10
        : null,
      abdeckung: Number(eaRoh.abdeckung),
    }
    : null;

  const g = sales?.gesamt ?? {};
  return {
    status,
    zeitraum: sales?.zeitraum ?? null,
    data_timestamp: sales?.data_timestamp ?? listings?.data_timestamp ?? null,
    is_provisional: sales?.is_provisional ?? false,
    kpis: {
      umsatz: g.umsatzOrdered ?? null,
      waehrung: g.waehrung ?? null,
      sessions: g.sessions ?? null,
      pageViews: g.pageViews ?? null,
      unitsOrdered: g.unitsOrdered ?? null,
      cvr: g.cvrUnitSession ?? null,
      durchschnittspreis: g.durchschnittspreis ?? null,
      retourenquote: g.retourenquote ?? null,
    },
    listings: listings ? {
      aktiv: listings.gesamt?.aktiv ?? null,
      inaktiv: listings.gesamt?.inaktiv ?? null,
      ausverkauft: listings.bestand_merchant?.ausverkauft ?? null,
      preis_min: listings.preis_aktiv?.min ?? null,
      preis_max: listings.preis_aktiv?.max ?? null,
    } : null,
    bewegung,
    /**
     * Ertrag eines ABGESCHLOSSENEN Monats. null = kein Monat der letzten sechs
     * ist weit genug abgerechnet; dann wird nichts behauptet.
     */
    ertrag_monat: ertragMonat,
    werbung: { spend: werbung, tacos, zeitraum: { von, bis } },
    diagnosen_offen: diagRes?.count ?? null,
    pruefungen: hinweise.slice(0, 3),
    top_changes: (changesRes.data ?? []).map(mitTitel),
    warnungen: [
      // Der Ertrag steht ganz oben auf der Seite. Ohne diesen Satz liest ihn
      // jeder als Ergebnis, obwohl die Gebuehren noch fehlen.
      ...(bewegung?.gesamt?.gebuehren_abdeckung != null
        && bewegung.gesamt.gebuehren_abdeckung < 0.8
        ? [
          `Der „Ertrag nach Werbung" der letzten 30 Tage ist zu HOCH: Amazon hat `
          + `erst ${Math.round(bewegung.gesamt.gebuehren_abdeckung * 100)} % der `
          + "Bestellungen dieses Zeitraums abgerechnet. Umsatz und Wareneinsatz "
          + "stehen sofort fest, die Gebühren kommen mit Wochen Verzug — der "
          + "fehlende Teil ist noch nicht abgezogen."
          + (ertragMonat
            ? ` Belastbar ist der abgeschlossene Monat ${ertragMonat.monat}: `
              + `${ertragMonat.ertrag.toFixed(2)} € bei `
              + `${Math.round(ertragMonat.abdeckung * 100)} % Abdeckung.`
            : " Kein Monat der letzten sechs ist weit genug abgerechnet, um eine "
              + "belastbare Zahl danebenzustellen."),
        ]
        : []),
      ...(sales?.konsistenz && !sales.konsistenz.ok
        ? ["Sales-Daten: byDate und byAsin weichen ab — Zahlen prüfen."]
        : []),
      // Aus der Produktsicht durchgereicht: fehlende Lagergebuehren-Monate,
      // unvollstaendig abgerechnete Bestellungen. Beides macht den Gewinn zu
      // schoen, und beides sieht man der Zahl selbst nicht an.
      ...((aktuell?.warnungen ?? []) as string[]),
    ],
    datenqualitaet: {
      sales_vorhanden: Boolean(sales),
      listings_vorhanden: Boolean(listings),
      bewegung_vorhanden: Boolean(bewegung),
    },
  };
}

// stockouts.ts — Nachschub-Radar (DataDoe #4: „Welche Produkte sind aus/laufen leer
// und was kostet mich das?").
//
// EHRLICH: Für diesen Seller liefert Amazon KEINE Live-Bestandszahlen (der
// FBA-Inventory-Report braucht die App-Rolle „Amazon Fulfillment", die nicht
// aktiv ist). Wir schließen den Ausverkauf deshalb aus zwei echten Signalen:
//   1) Velocity-Abbruch — ein Produkt, das normal verkauft, hat plötzlich Tage
//      ohne jeden Verkauf. Das ist der stärkste Hinweis auf leeren Bestand.
//   2) Buy-Box-Verlust — Amazon zeigt dein Angebot nicht mehr in der Buy Box
//      (buyBoxPercentage < 100), obwohl Traffic da ist. Häufig = kein Bestand.
// Das sind INDIZIEN, keine Bestandsmessung. Darum reden wir von „wahrscheinlich".

// --- Methodik-Parameter (Sensitivität; bewusst als benannte Konstanten) ---
export const FENSTER_TAGE = 90;          // Beobachtungsfenster der Velocity
export const MIN_VELO = 0.3;             // < 0,3 Stk/Tag: zu selten, Nulltage sind normal -> ignorieren
export const LEER_TAGE = 7;              // >= 7 Tage kein Verkauf trotz Velocity -> wahrscheinlich leer
export const LEER_MAX_TAGE = 45;         // > 45 Tage tot: kein Stockout mehr, sondern Ladenhüter (siehe #5)
export const KRITISCH_TAGE = 4;          // 4–6 Tage -> Verkäufe brechen ab (Warnung)
export const BUYBOX_MIN = 90;            // Buy-Box unter 90 % -> Verfügbarkeitsproblem
export const BUYBOX_MIN_SESSIONS = 20;   // nur relevant, wenn überhaupt Traffic da ist

/** Reichweite, ab der nachbestellt werden muss (Herstellung + Transit + Puffer). */
export const REICHWEITE_KNAPP_TAGE = 21;

// Mit echten Lagerdaten (fba_bestand) unterscheiden wir jetzt, was vorher nicht
// trennbar war: „leer und nichts bestellt" (dringend) von „leer, Ware kommt"
// (erledigt) und „läuft bald leer" (jetzt handeln). Ohne Lagerdaten bleibt es
// beim alten Velocity-Schluss — dann ist der Bestand ehrlich unbekannt.
// Fuer den Deckungsbeitrag: dieselbe Rechnung wie in der Produktuebersicht,
// damit nicht zwei Ansichten verschiedene Gewinne behaupten.
import { produktUebersicht } from "./produkte.ts";

export type Status =
  | "leer_ohne_nachschub"
  | "leer"              // aus der Verkaufslücke geschlossen, Bestand unbekannt
  | "leer_mit_nachschub"
  | "reichweite_knapp"
  | "buybox"
  | "kritisch"
  | "ok";

export interface AsinInput {
  velo_tag: number;
  tage_ohne_verkauf: number;
  avg_preis_cents: number;
  buybox_pct: number | null;
  sessions: number | null;
  /** Verkaufsfähige Menge. null = kein Lagerdatensatz (unbekannt), NICHT 0. */
  bestand?: number | null;
  /** Nachschub unterwegs (shipped + working + receiving). */
  nachschub_unterwegs?: number | null;
  bestand_bekannt?: boolean;
  /** Tage bis leer (bestand / Velocity). null = unbekannt. */
  reichweite_tage?: number | null;
  /**
   * Deckungsbeitrag je Stück in Cent: Nettopreis − EK − Amazon-Gebühren.
   * null/fehlend = nicht berechenbar (kein EK oder keine Gebühren hinterlegt).
   * Dann wird auf den Umsatz zurückgefallen — und das wird ausgewiesen.
   */
  deckungsbeitrag_cents?: number | null;
}
export interface Bewertung {
  status: Status;
  schwere: number;               // 5 leer ohne Nachschub … 0 ok — für die Sortierung
  verlust_cents: number;         // leer: laufend entgangen; buybox: Monatsrate
  verlust_art: "laufend" | "monatsrate" | null;
  /**
   * Worauf der Verlust gerechnet ist. "gewinn" = entgangener Deckungsbeitrag,
   * die ehrliche Zahl. "umsatz" = Notbehelf, weil EK oder Gebühren fehlen —
   * dann ist der Betrag deutlich zu hoch und darf nicht als Gewinn gelesen
   * werden. null = kein Verlust ausgewiesen.
   */
  verlust_basis: "gewinn" | "umsatz" | null;
}

/**
 * Wert einer nicht verkauften Einheit. Bevorzugt der Deckungsbeitrag — eine
 * entgangene Bestellung kostet den Gewinn, nicht den Umsatz. Fehlt er, wird der
 * Preis genommen UND das als Notbehelf gekennzeichnet.
 */
function stueckwert(i: AsinInput): { cents: number; basis: "gewinn" | "umsatz" } {
  const db = i.deckungsbeitrag_cents;
  if (typeof db === "number" && Number.isFinite(db) && db > 0) {
    return { cents: db, basis: "gewinn" };
  }
  return { cents: nz(i.avg_preis_cents), basis: "umsatz" };
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reine Bewertung EINER ASIN. Reihenfolge = Dringlichkeit:
 *   1. Lager leer UND nichts bestellt  — verliert Umsatz, niemand hat gehandelt
 *   2. Lager leer, aus Verkaufslücke geschlossen (Bestand unbekannt)
 *   3. Lager leer, aber Ware unterwegs — Verlust läuft, ist aber adressiert
 *   4. Reichweite knapp und nichts bestellt — jetzt nachbestellen
 *   5. Buy-Box-Verlust, 6. Verkäufe brechen ab
 */
export function bewerteAsin(i: AsinInput): Bewertung {
  const velo = nz(i.velo_tag);
  if (velo < MIN_VELO) return { status: "ok", schwere: 0, verlust_cents: 0, verlust_art: null, verlust_basis: null };

  const tageOhne = nz(i.tage_ohne_verkauf);
  const preis = nz(i.avg_preis_cents);
  const ok = { status: "ok" as const, schwere: 0, verlust_cents: 0, verlust_art: null, verlust_basis: null };

  // --- Mit echten Lagerdaten ---
  if (i.bestand_bekannt) {
    const bestand = nz(i.bestand);
    const unterwegs = nz(i.nachschub_unterwegs);

    if (bestand === 0) {
      // Entgangener Umsatz seit dem letzten Verkauf; mindestens ein Tag, denn
      // leeres Lager kostet ab sofort.
      const tage = Math.max(1, Math.min(tageOhne, LEER_MAX_TAGE));
      const wert = stueckwert(i);
      const verlust = Math.round(velo * tage * wert.cents);
      return unterwegs > 0
        ? { status: "leer_mit_nachschub", schwere: 3, verlust_cents: verlust, verlust_art: "laufend", verlust_basis: wert.basis }
        : { status: "leer_ohne_nachschub", schwere: 5, verlust_cents: verlust, verlust_art: "laufend", verlust_basis: wert.basis };
    }

    const reichweite = i.reichweite_tage == null ? null : nz(i.reichweite_tage);
    if (reichweite != null && reichweite <= REICHWEITE_KNAPP_TAGE && unterwegs === 0) {
      // Noch kein Verlust — eine Warnung mit Frist. Deshalb 0 € und kein „laufend".
      return { status: "reichweite_knapp", schwere: 3, verlust_cents: 0, verlust_art: null, verlust_basis: null };
    }
    // Bestand vorhanden und ausreichend -> Buy-Box/Abbruch trotzdem prüfen (unten).
  } else {
    // --- Ohne Lagerdaten: wie bisher aus der Verkaufslücke schließen ---
    if (tageOhne >= LEER_TAGE && tageOhne <= LEER_MAX_TAGE) {
      const wert = stueckwert(i);
      const verlust = Math.round(velo * tageOhne * wert.cents);
      return { status: "leer", schwere: 4, verlust_cents: verlust, verlust_art: "laufend", verlust_basis: wert.basis };
    }
    // Länger als LEER_MAX_TAGE tot: kein akuter Stockout mehr -> Ladenhüter-Radar (#5).
    if (tageOhne > LEER_MAX_TAGE) return ok;
  }

  if (i.buybox_pct != null && i.buybox_pct < BUYBOX_MIN && nz(i.sessions) >= BUYBOX_MIN_SESSIONS) {
    // Anteil entgangener Verkäufe ≈ (100 − BB) / BB, gedeckelt bei 1.
    const bb = Math.max(1, i.buybox_pct);
    const anteil = Math.min(1, (100 - bb) / bb);
    const wert = stueckwert(i);
    const verlust = Math.round(velo * 30 * anteil * wert.cents); // Monatsrate
    return { status: "buybox", schwere: 2, verlust_cents: verlust, verlust_art: "monatsrate", verlust_basis: wert.basis };
  }

  if (tageOhne >= KRITISCH_TAGE && tageOhne <= LEER_MAX_TAGE) {
    return { status: "kritisch", schwere: 1, verlust_cents: 0, verlust_art: null, verlust_basis: null };
  }

  return ok;
}

/**
 * DB-Wrapper: Velocity-Basis (RPC) + Buy-Box aus dem letzten Sales&Traffic-Report
 * je ASIN zusammenführen, bewerten, die Auffälligen (nicht „ok") wertabsteigend
 * zurückgeben. Reichert Produktnamen an und liefert das S&T-Fenster mit.
 */
export async function stockoutRadar(supabase: any, tenant_id: string): Promise<unknown> {
  const [basisRes, stRes, asinRes, ertragRes] = await Promise.all([
    supabase.rpc("stockout_basis", { p_tenant: tenant_id, p_tage: FENSTER_TAGE }),
    supabase.from("report_data").select("payload")
      .eq("tenant_id", tenant_id).eq("report_type", "GET_SALES_AND_TRAFFIC_REPORT").eq("is_latest", true).maybeSingle(),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
    // Deckungsbeitrag je Stueck: dieselbe Rechnung wie in der Produktuebersicht,
    // damit beide Ansichten nicht verschiedene Gewinne behaupten.
    produktUebersicht(supabase, tenant_id, { tage: FENSTER_TAGE }).catch(() => null),
  ]);

  const basis = (basisRes.data ?? []) as any[];
  const titel = new Map<string, string>(
    ((asinRes.data ?? []) as any[]).map((a) => [String(a.asin), String(a.produktname ?? a.asin)]),
  );

  // Buy-Box je ASIN aus dem letzten S&T-Report.
  const bbMap = new Map<string, { buybox: number | null; sessions: number | null; units: number | null }>();
  let stFenster: { von: string | null; bis: string | null } | null = null;
  const payload = (stRes.data as any)?.payload;
  if (payload) {
    const spec = payload.reportSpecification?.dataStartTime
      ? { von: String(payload.reportSpecification.dataStartTime).slice(0, 10), bis: String(payload.reportSpecification.dataEndTime ?? "").slice(0, 10) || null }
      : null;
    stFenster = spec;
    for (const el of (payload.salesAndTrafficByAsin ?? []) as any[]) {
      const a = String(el.childAsin ?? el.parentAsin ?? "");
      if (!a) continue;
      const t = el.trafficByAsin ?? {};
      const s = el.salesByAsin ?? {};
      bbMap.set(a, {
        buybox: t.buyBoxPercentage != null ? Number(t.buyBoxPercentage) : null,
        sessions: t.sessions != null ? Number(t.sessions) : null,
        units: s.unitsOrdered != null ? Number(s.unitsOrdered) : null,
      });
    }
  }

  // Deckungsbeitrag je Stueck aus der Produktuebersicht. Sie rechnet bereits
  // netto und mit Gebuehren; hier wird nur durch die Einheiten geteilt.
  const dbJeAsin = new Map<string, number>();
  for (const p of ((ertragRes as any)?.produkte ?? []) as any[]) {
    const einheiten = Number(p.einheiten) || 0;
    const ergebnis = p.nettogewinn_vor_werbung;
    if (einheiten > 0 && typeof ergebnis === "number") {
      dbJeAsin.set(String(p.asin), Math.round((ergebnis / einheiten) * 100));
    }
  }

  const zeilen = basis.map((r) => {
    const bb = bbMap.get(String(r.asin));
    const eingabe: AsinInput = {
      velo_tag: nz(r.velo_tag),
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
      avg_preis_cents: nz(r.avg_preis_cents),
      buybox_pct: bb?.buybox ?? null,
      deckungsbeitrag_cents: dbJeAsin.get(String(r.asin)) ?? null,
      sessions: bb?.sessions ?? null,
      bestand: r.bestand == null ? null : nz(r.bestand),
      nachschub_unterwegs: r.nachschub_unterwegs == null ? null : nz(r.nachschub_unterwegs),
      bestand_bekannt: Boolean(r.bestand_bekannt),
      reichweite_tage: r.reichweite_tage == null ? null : Number(r.reichweite_tage),
    };
    const b = bewerteAsin(eingabe);
    return {
      asin: String(r.asin),
      produktname: titel.get(String(r.asin)) ?? String(r.asin),
      velo_tag: nz(r.velo_tag),
      units_fenster: nz(r.units_fenster),
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
      letzter_verkauf: r.letzter_verkauf ?? null,
      avg_preis_cents: nz(r.avg_preis_cents),
      buybox_pct: bb?.buybox ?? null,
      sessions: bb?.sessions ?? null,
      bestand: eingabe.bestand,
      nachschub_unterwegs: eingabe.nachschub_unterwegs,
      bestand_bekannt: eingabe.bestand_bekannt,
      reichweite_tage: eingabe.reichweite_tage,
      ...b,
    };
  }).filter((z) => z.status !== "ok");

  zeilen.sort((a, b) => (b.schwere - a.schwere) || (b.verlust_cents - a.verlust_cents));

  const zaehle = (s: Status) => zeilen.filter((z) => z.status === s).length;
  return {
    waehrung: "EUR",
    fenster_tage: FENSTER_TAGE,
    st_fenster: stFenster,
    zeilen,
    // Headline: konkret schon entgangener Umsatz ALLER leeren Produkte (wächst täglich).
    summe_laufend_cents: zeilen
      .filter((z) => z.status === "leer" || z.status === "leer_ohne_nachschub" || z.status === "leer_mit_nachschub")
      .reduce((s, z) => s + z.verlust_cents, 0),
    // Der dringende Teil davon: leer UND nichts bestellt.
    summe_ohne_nachschub_cents: zeilen
      .filter((z) => z.status === "leer_ohne_nachschub")
      .reduce((s, z) => s + z.verlust_cents, 0),
    anzahl_leer_ohne_nachschub: zaehle("leer_ohne_nachschub"),
    anzahl_leer_mit_nachschub: zaehle("leer_mit_nachschub"),
    anzahl_reichweite_knapp: zaehle("reichweite_knapp"),
    anzahl_leer: zaehle("leer"), // nur wo der Bestand unbekannt ist
    anzahl_kritisch: zaehle("kritisch"),
    anzahl_buybox: zaehle("buybox"),
    anzahl_asins_geprueft: basis.length,
    hat_buybox_daten: bbMap.size > 0,
    hat_bestandsdaten: basis.some((r: any) => r.bestand_bekannt),
    reichweite_knapp_tage: REICHWEITE_KNAPP_TAGE,
  };
}

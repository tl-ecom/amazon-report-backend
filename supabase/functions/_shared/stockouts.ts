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
export const KRITISCH_TAGE = 4;          // 4–6 Tage -> Verkäufe brechen ab (Warnung)
export const BUYBOX_MIN = 90;            // Buy-Box unter 90 % -> Verfügbarkeitsproblem
export const BUYBOX_MIN_SESSIONS = 20;   // nur relevant, wenn überhaupt Traffic da ist

export type Status = "leer" | "kritisch" | "buybox" | "ok";

export interface AsinInput {
  velo_tag: number;
  tage_ohne_verkauf: number;
  avg_preis_cents: number;
  buybox_pct: number | null;
  sessions: number | null;
}
export interface Bewertung {
  status: Status;
  schwere: number;               // 3 leer, 2 buybox, 1 kritisch, 0 ok — für die Sortierung
  verlust_cents: number;         // leer: laufend entgangen (velo × Tage × Preis); buybox: Monatsrate
  verlust_art: "laufend" | "monatsrate" | null;
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reine Bewertung EINER ASIN. Reihenfolge = Schwere: erst „leer" (konkret schon
 * entgangener Umsatz), dann „buybox" (laufende Rate), dann „kritisch" (Warnung).
 */
export function bewerteAsin(i: AsinInput): Bewertung {
  const velo = nz(i.velo_tag);
  if (velo < MIN_VELO) return { status: "ok", schwere: 0, verlust_cents: 0, verlust_art: null };

  const tageOhne = nz(i.tage_ohne_verkauf);
  const preis = nz(i.avg_preis_cents);

  if (tageOhne >= LEER_TAGE) {
    const verlust = Math.round(velo * tageOhne * preis);
    return { status: "leer", schwere: 3, verlust_cents: verlust, verlust_art: "laufend" };
  }

  if (i.buybox_pct != null && i.buybox_pct < BUYBOX_MIN && nz(i.sessions) >= BUYBOX_MIN_SESSIONS) {
    // Anteil entgangener Verkäufe ≈ (100 − BB) / BB, gedeckelt bei 1.
    const bb = Math.max(1, i.buybox_pct);
    const anteil = Math.min(1, (100 - bb) / bb);
    const verlust = Math.round(velo * 30 * anteil * preis); // Monatsrate
    return { status: "buybox", schwere: 2, verlust_cents: verlust, verlust_art: "monatsrate" };
  }

  if (tageOhne >= KRITISCH_TAGE) {
    return { status: "kritisch", schwere: 1, verlust_cents: 0, verlust_art: null };
  }

  return { status: "ok", schwere: 0, verlust_cents: 0, verlust_art: null };
}

/**
 * DB-Wrapper: Velocity-Basis (RPC) + Buy-Box aus dem letzten Sales&Traffic-Report
 * je ASIN zusammenführen, bewerten, die Auffälligen (nicht „ok") wertabsteigend
 * zurückgeben. Reichert Produktnamen an und liefert das S&T-Fenster mit.
 */
export async function stockoutRadar(supabase: any, tenant_id: string): Promise<unknown> {
  const [basisRes, stRes, asinRes] = await Promise.all([
    supabase.rpc("stockout_basis", { p_tenant: tenant_id, p_tage: FENSTER_TAGE }),
    supabase.from("report_data").select("payload")
      .eq("tenant_id", tenant_id).eq("report_type", "GET_SALES_AND_TRAFFIC_REPORT").eq("is_latest", true).maybeSingle(),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
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

  const zeilen = basis.map((r) => {
    const bb = bbMap.get(String(r.asin));
    const eingabe: AsinInput = {
      velo_tag: nz(r.velo_tag),
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
      avg_preis_cents: nz(r.avg_preis_cents),
      buybox_pct: bb?.buybox ?? null,
      sessions: bb?.sessions ?? null,
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
    // Headline: konkret schon entgangener Umsatz der aktuell leeren Produkte (wächst täglich).
    summe_laufend_cents: zeilen.filter((z) => z.status === "leer").reduce((s, z) => s + z.verlust_cents, 0),
    anzahl_leer: zaehle("leer"),
    anzahl_kritisch: zaehle("kritisch"),
    anzahl_buybox: zaehle("buybox"),
    anzahl_asins_geprueft: basis.length,
    hat_buybox_daten: bbMap.size > 0,
  };
}

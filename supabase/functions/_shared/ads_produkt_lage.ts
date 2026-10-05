// ads_produkt_lage.ts — Lage je verwaltetem Produkt.
//
// Die übrigen Ads-Leser arbeiten je Konto oder je Kampagne. Gesteuert werden
// aber Produkte, und in jedem Produkt laufen zwei Steuerungen nebeneinander:
// Helium 10 und Pulse (siehe ads_steuerung.ts). Hier stehen beide Teile je
// Produkt nebeneinander, die letzten N Tage gegen die N davor.
//
// Kein Urteil und keine Ursache: zwei Fenster, zwei Summen. Die Einstufung ist
// die von heute — war eine Kampagne im Vorfenster noch anders gesteuert, weiß
// die Zahl das nicht.

import { margenAus, type ProduktMarge } from "./ads_kandidaten.ts";
import { marktplatzKopf } from "./ads_marktplatz.ts";
import { produktUebersicht } from "./produkte.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

export interface LageZeile {
  produkt: string; modus: "h10" | "pulse"; fenster: "aktuell" | "davor";
  kampagnen: number | string; impressions: number | string; clicks: number | string;
  spend_cents: number | string; sales_cents: number | string; orders: number | string;
}

export interface Fenster {
  klicks: number; kosten: number; umsatz: number; bestellungen: number;
  /** null ohne Umsatz — nicht 0. */
  acos: number | null;
}

const LEER = { klicks: 0, spend: 0, sales: 0, orders: 0 };

function fenster(s: typeof LEER): Fenster {
  return {
    klicks: s.klicks, kosten: r2(s.spend / 100), umsatz: r2(s.sales / 100), bestellungen: s.orders,
    acos: s.sales > 0 ? Math.round((s.spend / s.sales) * 10000) / 10000 : null,
  };
}

function teil(zeilen: LageZeile[]) {
  const summe = (f: "aktuell" | "davor") => zeilen.filter((z) => z.fenster === f).reduce((n, z) => ({
    klicks: n.klicks + Number(z.clicks), spend: n.spend + Number(z.spend_cents),
    sales: n.sales + Number(z.sales_cents), orders: n.orders + Number(z.orders),
  }), LEER);
  const aktuell = fenster(summe("aktuell"));
  const davor = fenster(summe("davor"));
  return {
    // Kampagnen mit Daten im aktuellen Fenster.
    kampagnen: zeilen.filter((z) => z.fenster === "aktuell").reduce((n, z) => n + Number(z.kampagnen), 0),
    aktuell, davor,
    kosten_differenz: r2(aktuell.kosten - davor.kosten),
    umsatz_differenz: r2(aktuell.umsatz - davor.umsatz),
    bestellungen_differenz: aktuell.bestellungen - davor.bestellungen,
  };
}

export interface GesamtZeile {
  produkt: string; fenster: "aktuell" | "davor";
  umsatz_cents: number | string | null; einheiten: number | string;
}

/**
 * Gesamtumsatz des Produkts (alle Bestellungen) gegen die Werbung.
 * TACoS = Werbekosten / Gesamtumsatz. `werbeanteil` = Werbeumsatz / Gesamtumsatz;
 * er kann über 1 liegen, weil Amazon Werbeumsatz bis 14 Tage nach dem Klick
 * zuschreibt und dabei auch andere ASINs der Marke mitzählt.
 */
function gegenGesamt(g: GesamtZeile | undefined, werbung: Fenster) {
  // Kein Bestell-Eintrag im Fenster = kein Umsatz bekannt. Nicht 0: die ASIN-
  // Zuordnung kann fehlen (Kampagne ohne Impression in 90 Tagen).
  if (!g || g.umsatz_cents === null) return { umsatz: null, einheiten: null, tacos: null, werbeanteil: null };
  const umsatz = r2(Number(g.umsatz_cents) / 100);
  return {
    umsatz, einheiten: Number(g.einheiten),
    tacos: umsatz > 0 ? Math.round((werbung.kosten / umsatz) * 10000) / 10000 : null,
    werbeanteil: umsatz > 0 ? Math.round((werbung.umsatz / umsatz) * 1000) / 1000 : null,
  };
}

/**
 * Was nach Werbung übrig bleibt: Gesamtumsatz x Marge vor Werbung − Werbekosten.
 * Die Marge ist der Deckungsbeitrag vor Werbung je Euro Bruttoumsatz (90 Tage,
 * aus der Produktübersicht) — zugleich der TACoS, bei dem nichts übrig bliebe.
 * Mehrere ASINs: die schwächste Marge, wie bei den Ernte-Kandidaten.
 * null, sobald Umsatz oder Marge unbekannt sind — kein geratener Gewinn.
 */
function gewinn(umsatz: number | null, kosten: number, marge: number | null): number | null {
  return umsatz === null || marge === null ? null : r2(umsatz * marge - kosten);
}

export function baueProduktLage(
  zeilen: LageZeile[], budgetLeer: Record<string, number | string>,
  gesamtZeilen: GesamtZeile[] = [], asins: Record<string, string[]> = {},
  margen: Map<string, ProduktMarge> = new Map(),
) {
  const produkte = [...new Set(zeilen.map((z) => z.produkt))].sort();
  return produkte.map((produkt) => {
    const eigene = zeilen.filter((z) => z.produkt === produkt);
    const gesamt = teil(eigene);
    const h10 = teil(eigene.filter((z) => z.modus === "h10"));
    const g = (f: "aktuell" | "davor") => gesamtZeilen.find((x) => x.produkt === produkt && x.fenster === f);
    const alle = { aktuell: gegenGesamt(g("aktuell"), gesamt.aktuell), davor: gegenGesamt(g("davor"), gesamt.davor) };
    const bekannt = (asins[produkt] ?? []).map((a) => margen.get(a.toUpperCase())?.break_even)
      .filter((m): m is number => m !== null && m !== undefined);
    const marge = bekannt.length ? Math.round(Math.min(...bekannt) * 10000) / 10000 : null;
    return {
      produkt,
      asins: asins[produkt] ?? [],
      // Alle Bestellungen des Produkts, nicht nur die aus Werbung.
      alle_bestellungen: alle,
      // Marge vor Werbung = der TACoS, bei dem nichts übrig bliebe.
      break_even_tacos: marge,
      gewinn_nach_werbung: {
        aktuell: gewinn(alle.aktuell.umsatz, gesamt.aktuell.kosten, marge),
        davor: gewinn(alle.davor.umsatz, gesamt.davor.kosten, marge),
      },
      gesamt,
      h10,
      pulse: teil(eigene.filter((z) => z.modus === "pulse")),
      // Wie viel der Werbekosten des Produkts Helium 10 steuert. null ohne Kosten.
      h10_anteil_kosten: gesamt.aktuell.kosten > 0 ? Math.round((h10.aktuell.kosten / gesamt.aktuell.kosten) * 1000) / 1000 : null,
      kampagnentage_budget_leer: Number(budgetLeer[produkt]) || 0,
    };
  }).sort((a, b) => b.gesamt.aktuell.kosten - a.gesamt.aktuell.kosten);
}

export async function adsProduktLage(
  supabase: any, tenant_id: string, opts?: { tage?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const tage = Math.max(1, Math.min(Number(opts?.tage) || 7, 60));
  const { data, error } = await supabase.rpc("ads_produkt_lage", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_tage: tage,
  });
  if (error) throw new Error("ads_produkt_lage: " + error.message);

  // Ohne Margen bleibt die Lage brauchbar, nur eben ohne Gewinn.
  let margen = new Map<string, ProduktMarge>();
  let margenFehler: string | null = null;
  try {
    const pu = await produktUebersicht(supabase, tenant_id, { tage: 90 }) as { produkte?: any[] };
    margen = margenAus(pu?.produkte ?? []);
  } catch (e) {
    margenFehler = String((e as Error)?.message ?? e);
  }

  return {
    ...kopf,
    tage,
    daten_bis: data?.letzter_tag ?? null,
    produkte: baueProduktLage(
      (data?.zeilen ?? []) as LageZeile[], (data?.budget_leer ?? {}) as Record<string, number>,
      (data?.gesamtumsatz ?? []) as GesamtZeile[], (data?.asins ?? {}) as Record<string, string[]>,
      margen,
    ),
    asins_mehrdeutig: data?.asins_mehrdeutig ?? [],
    hinweise: [
      `Verglichen werden die letzten ${tage} Tage mit Ads-Daten (bis ${data?.letzter_tag ?? "—"}) mit den ${tage} Tagen davor. `
      + "Die jüngsten drei Tage passt Amazon noch an.",
      "`h10` und `pulse` teilen die Kampagnen des Produkts nach der HEUTIGEN Einstufung in ads_steuerung. "
      + "Die beiden Teile sind kein Wettkampf unter gleichen Bedingungen: Helium 10 steuert meist die großen "
      + "Kampagnen, Pulse die kleinen und neuen.",
      "`gesamt`, `h10` und `pulse` sind Werbung. `alle_bestellungen` ist der Umsatz des Produkts aus ALLEN "
      + "Bestellungen im selben Fenster (ohne stornierte, brutto wie der Werbeumsatz), `tacos` = Werbekosten "
      + "durch diesen Umsatz. Welche ASINs zum Produkt zählen, steht in `asins`: was seine Kampagnen in den "
      + "letzten 90 Tagen beworben haben. `werbeanteil` kann über 1 liegen — Amazon schreibt Werbeumsatz "
      + "bis 14 Tage nach dem Klick zu, auch für andere ASINs der Marke.",
      "`gewinn_nach_werbung` = Gesamtumsatz x `break_even_tacos` − Werbekosten. `break_even_tacos` ist der "
      + "Deckungsbeitrag vor Werbung je Euro Bruttoumsatz aus der Produktübersicht (letzte 90 Tage, bei mehreren "
      + "ASINs die schwächste) — liegt der TACoS darüber, kostet die Werbung mehr, als das Produkt abwirft. "
      + "Eine Marge aus 90 Tagen auf eine Woche gelegt: Preiswechsel der Woche stecken nur anteilig darin.",
      ...(margenFehler ? ["Margen nicht lesbar, deshalb kein Gewinn: " + margenFehler] : []),
      ...((data?.asins_mehrdeutig ?? []).length
        ? ["ASINs, die Kampagnen mehrerer Produkte bewerben, fehlen im Gesamtumsatz: " + (data.asins_mehrdeutig as string[]).join(", ") + "."]
        : []),
      "`kampagnentage_budget_leer` zählt Sponsored-Products-Kampagnen und läuft über Kalendertage bis heute, "
      + "nicht über das Ads-Fenster. Gemessen wird erst seit dem 04.10.2026.",
    ],
  };
}

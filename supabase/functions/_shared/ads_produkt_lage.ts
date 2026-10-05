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

import { marktplatzKopf } from "./ads_marktplatz.ts";

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

export function baueProduktLage(zeilen: LageZeile[], budgetLeer: Record<string, number | string>) {
  const produkte = [...new Set(zeilen.map((z) => z.produkt))].sort();
  return produkte.map((produkt) => {
    const eigene = zeilen.filter((z) => z.produkt === produkt);
    const gesamt = teil(eigene);
    const h10 = teil(eigene.filter((z) => z.modus === "h10"));
    return {
      produkt,
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

  return {
    ...kopf,
    tage,
    daten_bis: data?.letzter_tag ?? null,
    produkte: baueProduktLage((data?.zeilen ?? []) as LageZeile[], (data?.budget_leer ?? {}) as Record<string, number>),
    hinweise: [
      `Verglichen werden die letzten ${tage} Tage mit Ads-Daten (bis ${data?.letzter_tag ?? "—"}) mit den ${tage} Tagen davor. `
      + "Die jüngsten drei Tage passt Amazon noch an.",
      "`h10` und `pulse` teilen die Kampagnen des Produkts nach der HEUTIGEN Einstufung in ads_steuerung. "
      + "Die beiden Teile sind kein Wettkampf unter gleichen Bedingungen: Helium 10 steuert meist die großen "
      + "Kampagnen, Pulse die kleinen und neuen.",
      "Nur Werbeumsatz. Ob ein Produkt insgesamt wächst, steht in der Produktübersicht.",
      "`kampagnentage_budget_leer` zählt Sponsored-Products-Kampagnen und läuft über Kalendertage bis heute, "
      + "nicht über das Ads-Fenster. Gemessen wird erst seit dem 04.10.2026.",
    ],
  };
}

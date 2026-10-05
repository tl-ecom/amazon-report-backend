// sqp_produkt.ts — Kaufanteil je Suchbegriff für die verwalteten Produkte.
//
// Fällt der Umsatz eines Produkts, gibt es zwei Erklärungen: es wird weniger
// gesucht, oder es wird gleich viel gesucht und woanders gekauft. Brand
// Analytics (Search Query Performance) trennt das: Suchvolumen ist der Markt,
// Kaufanteil ist unser Stück davon.
//
// SQL (sqp_produkt_verlauf) liefert je Produkt die Wochen und Begriffe; hier
// wird nur verglichen. Kein Urteil über die Ursache.

import { marktplatzKopf } from "./ads_marktplatz.ts";

export interface BegriffWoche { von: string; volumen: number | string; kaufanteil: number | string; duenn: boolean }
export interface ProduktRoh {
  produkt: string; asins: string[] | null; kern_begriffe: number | string;
  wochen: Array<{ von: string; bis: string; begriffe: number; kern_volumen: number | string | null; kern_kaufanteil: number | string | null }> | null;
  begriffe: Array<{ begriff: string; kern: boolean; wochen: BegriffWoche[] }> | null;
}

const zahl = (x: number | string | null | undefined): number | null =>
  x === null || x === undefined ? null : Number(x);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Je Begriff: die letzte Woche des PRODUKTS gegen die Woche davor und gegen
 * die beste. Fehlt der Begriff in der letzten Woche, ist er aus Amazons
 * Top 100 der ASIN gefallen — `aktuell` ist dann null, nicht 0: Amazon nennt
 * dort keinen Kaufanteil, es gab aber auch kaum Käufe.
 */
export function baueSqpProdukt(p: ProduktRoh) {
  const wochen = (p.wochen ?? []).map((w) => ({
    von: w.von, bis: w.bis, begriffe: Number(w.begriffe),
    kern_volumen: zahl(w.kern_volumen), kern_kaufanteil: zahl(w.kern_kaufanteil),
  }));
  const letzte = wochen.at(-1)?.von ?? null;
  const vorletzte = wochen.at(-2)?.von ?? null;
  const begriffe = (p.begriffe ?? []).map((b) => {
    const w = b.wochen.map((x) => ({ von: x.von, volumen: Number(x.volumen), kaufanteil: Number(x.kaufanteil), duenn: x.duenn }));
    const in_ = (von: string | null) => w.find((x) => x.von === von) ?? null;
    const aktuell = in_(letzte);
    const davor = in_(vorletzte);
    const beste = w.reduce((m, x) => (m === null || x.kaufanteil > m.kaufanteil ? x : m), null as typeof w[number] | null);
    return {
      begriff: b.begriff, kern: b.kern,
      volumen: aktuell?.volumen ?? null,
      kaufanteil: aktuell?.kaufanteil ?? null,
      kaufanteil_davor: davor?.kaufanteil ?? null,
      kaufanteil_hoechst: beste?.kaufanteil ?? null,
      hoechst_in_woche: beste?.von ?? null,
      // Eigene Datenbasis der letzten Woche zu klein: ein Kauf mehr oder weniger kippt die Zahl.
      duenn: aktuell?.duenn ?? null,
      wochen: w,
    };
  });
  const erste = wochen.find((w) => w.kern_kaufanteil !== null) ?? null;
  const zuletzt = wochen.at(-1) ?? null;
  return {
    produkt: p.produkt, asins: p.asins ?? [], kern_begriffe: Number(p.kern_begriffe),
    wochen,
    // Der Kern über den ganzen Zeitraum: hat sich der Markt bewegt oder unser Anteil?
    kern_verlauf: erste && zuletzt && erste.von !== zuletzt.von ? {
      von: erste.von, bis: zuletzt.von,
      volumen_differenz_prozent: erste.kern_volumen && zuletzt.kern_volumen !== null
        ? r2(((zuletzt.kern_volumen - erste.kern_volumen) / erste.kern_volumen) * 100) : null,
      kaufanteil_differenz: erste.kern_kaufanteil !== null && zuletzt.kern_kaufanteil !== null
        ? r2(zuletzt.kern_kaufanteil - erste.kern_kaufanteil) : null,
      kaufanteil_hoechst: Math.max(...wochen.map((w) => w.kern_kaufanteil ?? 0)),
    } : null,
    begriffe,
  };
}

export async function sqpProduktVerlauf(
  supabase: any, tenant_id: string, opts?: { top?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const top = Math.max(1, Math.min(Number(opts?.top) || 15, 50));
  const { data, error } = await supabase.rpc("sqp_produkt_verlauf", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_top: top,
  });
  if (error) throw new Error("sqp_produkt_verlauf: " + error.message);
  const produkte = ((data ?? []) as ProduktRoh[]).map(baueSqpProdukt);
  return {
    ...kopf,
    top,
    produkte,
    hinweise: [
      "Quelle: Brand Analytics, Search Query Performance, wochenweise (Sonntag bis Samstag). Kaufanteil in "
      + "Prozent: der Anteil der Käufe nach dieser Suche, der auf die ASINs des Produkts fiel — Werbung und "
      + "organisch zusammen. Suchvolumen ist der ganze Markt.",
      "Amazon liefert je ASIN und Woche nur die 100 wichtigsten Begriffe, und welche das sind, wechselt. "
      + "`kern_volumen` und `kern_kaufanteil` (nach Volumen gewichtet) rechnen deshalb nur über die "
      + "Begriffe, die in JEDER vorhandenen Woche stehen — nur so ist Woche mit Woche vergleichbar.",
      "Es stehen nur die Wochen da, die schon abgerufen sind; zwischen ihnen können Wochen fehlen. "
      + "`kaufanteil` null heißt: der Begriff stand in der letzten Woche nicht unter den 100.",
      "`duenn`: unter 100 eigene Impressionen oder 10 eigene Klicks in der Woche — ein Kauf mehr oder weniger "
      + "kippt den Anteil. Begriffe sind nach Käufen über alle Wochen geordnet, Kernbegriffe zuerst.",
      ...(produkte.length === 0 ? ["Für kein verwaltetes Produkt liegen Search-Query-Performance-Wochen vor."] : []),
    ],
  };
}

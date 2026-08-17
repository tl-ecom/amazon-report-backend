// ads_verlauf.ts — Ads-Kennzahlen über einen FREI WÄHLBAREN Zeitraum, aus ads_daily.
//
// Unterschied zu get_ads_overview: jenes zeigt immer das zuletzt gezogene
// Report-Fenster aus report_data — der Nutzer kann daran nichts drehen. Hier
// bestimmt er den Zeitraum, und weil die Daten aus der Tagesreihe kommen, fällt
// zusätzlich eine Tageskurve ab.
//
// Arbeitsteilung: SQL summiert (ads_summen), TypeScript rechnet
// (kennzahlenAusSummen). Damit gibt es für ACOS & Co. genau eine Formel, egal
// über welchen Weg gefragt wird — und es wandern Summen statt Zehntausender
// Einzelzeilen über die Leitung.

import {
  type AdsKennzahlen,
  FORMELN,
  istVorlaeufig,
  kennzahlenAusSummen,
  VOLATIL_TAGE,
} from "./ads.ts";

interface SummenRow {
  ebene: string;
  schluessel: string | null;
  bezeichnung: string | null;
  impressions: number | string;
  clicks: number | string;
  spend_cents: number | string;
  sales_cents: number | string;
  orders: number | string;
  einheiten: number | string;
}

/** bigint kommt über PostgREST als String — überall durch Number(). */
function summen(r: SummenRow) {
  return {
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    spendCents: Number(r.spend_cents),
    salesCents: Number(r.sales_cents),
    orders: Number(r.orders),
    einheiten: Number(r.einheiten),
  };
}

const LEER = { impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0, einheiten: 0 };

function istDatum(x: unknown): x is string {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    !Number.isNaN(Date.parse(x + "T00:00:00Z"));
}

/**
 * Zeitraum aus den Argumenten. Entweder frei gewählt (von/bis) oder als Preset
 * „letzte N Tage". Verdrehte Grenzen werden getauscht statt abgelehnt — der
 * Kalender im Frontend lässt das zu, und die Absicht ist eindeutig.
 */
export function zeitraumAus(opts?: { tage?: unknown; von?: unknown; bis?: unknown }): { von: string; bis: string } {
  if (istDatum(opts?.von) && istDatum(opts?.bis)) {
    let von = opts!.von as string;
    let bis = opts!.bis as string;
    if (von > bis) [von, bis] = [bis, von];
    return { von, bis };
  }
  const fenster = Number(opts?.tage) > 0 ? Number(opts?.tage) : 30;
  const bis = new Date();
  const von = new Date(bis.getTime() - fenster * 86_400_000);
  return { von: von.toISOString().slice(0, 10), bis: bis.toISOString().slice(0, 10) };
}

export interface AdsVerlaufTag extends AdsKennzahlen {
  datum: string;
}

export async function adsVerlauf(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);

  const { data, error } = await supabase.rpc("ads_summen", {
    p_tenant: tenant_id,
    p_von: von,
    p_bis: bis,
  });
  if (error) throw new Error(`ads_summen: ${error.message}`);

  const rows = (data ?? []) as SummenRow[];
  const gesamtRow = rows.find((r) => r.ebene === "gesamt");

  const proTag: AdsVerlaufTag[] = rows
    .filter((r) => r.ebene === "tag" && r.schluessel)
    .map((r) => ({ datum: r.schluessel!, ...kennzahlenAusSummen(summen(r)) }))
    .sort((a, b) => a.datum.localeCompare(b.datum));

  const proKampagne = rows
    .filter((r) => r.ebene === "kampagne")
    .map((r) => ({
      campaignId: r.schluessel ?? "",
      campaignName: r.bezeichnung ?? "",
      ...kennzahlenAusSummen(summen(r)),
    }))
    .sort((a, b) => b.spend - a.spend);

  const proAsin = rows
    .filter((r) => r.ebene === "asin")
    .map((r) => ({ asin: r.schluessel ?? "", ...kennzahlenAusSummen(summen(r)) }))
    .sort((a, b) => b.spend - a.spend);

  // Vorläufig, sobald das ENDE in Amazons Nachbesserungsfenster reicht — der
  // Anfang des Zeitraums ist dafür egal.
  const vorlaeufig = istVorlaeufig(bis);

  const warnungen: string[] = [];
  if (vorlaeufig) {
    warnungen.push(
      `Zeitraum reicht in die letzten ${VOLATIL_TAGE} Tage — Ads-Zahlen (Spend/Sales) ` +
        "werden von Amazon noch angepasst. Als vorläufig behandeln.",
    );
  }
  if (proTag.length === 0) {
    warnungen.push("Keine Ads-Daten im gewählten Zeitraum.");
  } else {
    // Ehrlich benennen, wenn der Zeitraum weiter reicht als die Daten. Sonst
    // liest man Lücken als Nullen — „unbekannt ist nicht null".
    if (proTag[0].datum > von) warnungen.push(`Daten beginnen erst am ${proTag[0].datum}.`);
    const letzter = proTag[proTag.length - 1].datum;
    if (letzter < bis) warnungen.push(`Daten enden am ${letzter}.`);
  }

  return {
    zeitraum: { von, bis },
    tage_mit_daten: proTag.length,
    is_provisional: vorlaeufig,
    waehrungshinweis: "Beträge in der Währung des Werbeprofils (nicht im Report enthalten).",
    gesamt: kennzahlenAusSummen(gesamtRow ? summen(gesamtRow) : LEER),
    proTag,
    proKampagne,
    proAsin,
    formeln: FORMELN,
    warnungen,
  };
}

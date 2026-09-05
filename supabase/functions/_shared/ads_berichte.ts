// ads_berichte.ts — Suchbegriffe und Platzierungen über einen Zeitraum.
//
// Die zwei Berichte, die man bisher als Bulk-Datei zog, gelesen aus ihren
// Tagesreihen. Arbeitsteilung wie in ads_verlauf.ts: SQL summiert, hier
// entstehen die Kennzahlen — über kennzahlenAusSummen, damit ACOS & Co. auch
// für Suchbegriffe genau dieselbe Formel haben wie für Kampagnen.

import { FORMELN, istVorlaeufig, kennzahlenAusSummen, VOLATIL_TAGE } from "./ads.ts";
import { zeitraumAus } from "./ads_verlauf.ts";

interface Summen {
  impressions: number | string;
  clicks: number | string;
  spend_cents: number | string;
  sales_cents: number | string;
  orders: number | string;
  einheiten: number | string;
}

/** bigint kommt über PostgREST als String. */
function summen(r: Summen) {
  return {
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    spendCents: Number(r.spend_cents),
    salesCents: Number(r.sales_cents),
    orders: Number(r.orders),
    einheiten: Number(r.einheiten),
  };
}

interface Abdeckung {
  tabelle: string;
  von: string | null;
  bis: string | null;
  tage: number | string;
}

/**
 * Hinweise zur Abdeckung: fehlt die Tagesreihe ganz oder reicht sie nicht
 * über den Zeitraum, steht es hier — statt dass Lücken wie Nullen aussehen.
 */
export function abdeckungsHinweise(
  a: Abdeckung | undefined,
  von: string,
  bis: string,
  was: string,
): string[] {
  if (!a || !a.von || !a.bis || Number(a.tage) === 0) {
    return [`Noch keine ${was} vorhanden — der Report ist für diesen Mandanten noch nicht gelaufen.`];
  }
  const h: string[] = [];
  if (a.von > von) h.push(`${was} beginnen erst am ${a.von}.`);
  if (a.bis < bis) h.push(`${was} enden am ${a.bis}.`);
  if (istVorlaeufig(bis)) {
    h.push(`Zeitraum reicht in die letzten ${VOLATIL_TAGE} Tage — Amazon passt die Zahlen noch an. Als vorläufig behandeln.`);
  }
  return h;
}

/**
 * Suchbegriffe: welche Suchanfragen über welches Keyword/Target Klicks und
 * Verkäufe brachten. Nach Spend sortiert, gedeckelt (limit, Default 500).
 * Optional auf eine Kampagne eingeschränkt.
 */
export async function adsSuchbegriffe(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown; campaign_id?: unknown; limit?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);
  const campaign = typeof opts?.campaign_id === "string" && opts.campaign_id.trim() ? opts.campaign_id.trim() : null;
  const limit = Number(opts?.limit) > 0 ? Math.min(Number(opts?.limit), 5000) : 500;

  const [summenRes, abdeckungRes] = await Promise.all([
    supabase.rpc("ads_suchbegriffe_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis, p_campaign: campaign, p_limit: limit }),
    supabase.rpc("ads_tagesreihen_abdeckung", { p_tenant: tenant_id }),
  ]);
  if (summenRes.error) throw new Error(`ads_suchbegriffe_summen: ${summenRes.error.message}`);
  if (abdeckungRes.error) throw new Error(`ads_tagesreihen_abdeckung: ${abdeckungRes.error.message}`);

  const rows = (summenRes.data ?? []) as Array<Summen & {
    campaign_id: string; campaign_name: string | null; ad_group_id: string; ad_group_name: string | null;
    ziel_id: string; ziel_text: string | null; match_type: string | null; suchbegriff: string; tage: number | string;
  }>;

  const suchbegriffe = rows.map((r) => ({
    suchbegriff: r.suchbegriff,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    adGroupId: r.ad_group_id,
    adGroupName: r.ad_group_name,
    zielId: r.ziel_id,
    zielText: r.ziel_text,
    matchType: r.match_type,
    tage: Number(r.tage),
    ...kennzahlenAusSummen(summen(r)),
  }));

  const abdeckung = ((abdeckungRes.data ?? []) as Abdeckung[]).find((a) => a.tabelle === "suchbegriffe");

  return {
    zeitraum: { von, bis },
    kampagne: campaign,
    anzahl: suchbegriffe.length,
    gedeckelt: suchbegriffe.length >= limit,
    is_provisional: istVorlaeufig(bis),
    waehrungshinweis: "Beträge in der Währung des Werbeprofils.",
    suchbegriffe,
    formeln: FORMELN,
    hinweise: [
      ...abdeckungsHinweise(abdeckung, von, bis, "Suchbegriff-Daten"),
      ...(suchbegriffe.length >= limit ? [`Liste auf ${limit} Einträge (nach Spend) gedeckelt — limit erhöhen oder campaign_id setzen.`] : []),
      "Ein Suchbegriff mit Klicks, aber ohne Bestellungen über viele Tage ist ein Kandidat für ein Negative; " +
      "einer mit Bestellungen und gutem ACOS ohne eigenes Exact-Keyword ein Kandidat für die Ernte.",
    ],
  };
}

/**
 * Platzierungen: Leistung je Platzierung (Top of Search, Produktseite, Rest)
 * gesamt und je Kampagne — die Grundlage für die Platzierungs-Modifier.
 */
export async function adsPlatzierungen(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);

  const [summenRes, abdeckungRes] = await Promise.all([
    supabase.rpc("ads_placement_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    supabase.rpc("ads_tagesreihen_abdeckung", { p_tenant: tenant_id }),
  ]);
  if (summenRes.error) throw new Error(`ads_placement_summen: ${summenRes.error.message}`);
  if (abdeckungRes.error) throw new Error(`ads_tagesreihen_abdeckung: ${abdeckungRes.error.message}`);

  const rows = (summenRes.data ?? []) as Array<Summen & {
    ebene: string; campaign_id: string | null; campaign_name: string | null; platzierung: string;
  }>;

  const gesamt = rows.filter((r) => r.ebene === "gesamt")
    .map((r) => ({ platzierung: r.platzierung, ...kennzahlenAusSummen(summen(r)) }))
    .sort((a, b) => b.spend - a.spend);

  const proKampagne = new Map<string, { campaignId: string; campaignName: string | null; platzierungen: any[] }>();
  for (const r of rows.filter((x) => x.ebene === "kampagne")) {
    const id = r.campaign_id ?? "";
    let k = proKampagne.get(id);
    if (!k) {
      k = { campaignId: id, campaignName: r.campaign_name, platzierungen: [] };
      proKampagne.set(id, k);
    }
    k.platzierungen.push({ platzierung: r.platzierung, ...kennzahlenAusSummen(summen(r)) });
  }
  const kampagnen = [...proKampagne.values()]
    .map((k) => ({ ...k, platzierungen: k.platzierungen.sort((a, b) => b.spend - a.spend) }))
    .sort((a, b) => b.platzierungen.reduce((s, p) => s + p.spend, 0) - a.platzierungen.reduce((s, p) => s + p.spend, 0));

  const abdeckung = ((abdeckungRes.data ?? []) as Abdeckung[]).find((a) => a.tabelle === "placement");

  return {
    zeitraum: { von, bis },
    is_provisional: istVorlaeufig(bis),
    waehrungshinweis: "Beträge in der Währung des Werbeprofils.",
    gesamt,
    proKampagne: kampagnen,
    formeln: FORMELN,
    hinweise: [
      ...abdeckungsHinweise(abdeckung, von, bis, "Platzierungs-Daten"),
      "Die aktuell gesetzten Modifier stehen im Struktur-Snapshot (get_ads_struktur) — dort vergleichen, " +
      "ob eine Platzierung mit gutem ACOS noch Luft nach oben hat.",
    ],
  };
}

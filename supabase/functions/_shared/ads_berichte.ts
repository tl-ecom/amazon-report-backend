// ads_berichte.ts — Suchbegriffe, Platzierungen und Ziele über einen Zeitraum.
//
// Die Berichte, die man bisher als Bulk-Datei zog, gelesen aus ihren
// Tagesreihen. Arbeitsteilung wie in ads_verlauf.ts: SQL summiert, hier
// entstehen die Kennzahlen — über kennzahlenAusSummen, damit ACOS & Co. auch
// für Suchbegriffe genau dieselbe Formel haben wie für Kampagnen.
//
// ANZEIGENTYP: SP, SB und SD liegen in denselben Tabellen, unterschieden durch
// ad_product. SP rechnet 7 Tage Attribution, SB/SD 14 — das ist Amazons
// Vorgabe. Ein Vergleich über Typen hinweg vergleicht deshalb zwei Fenster;
// die Antwort sagt das, statt es zu verstecken.

import { type AdProduct, ATTRIBUTION_TAGE, FORMELN, istVorlaeufig, kennzahlenAusSummen, VOLATIL_TAGE } from "./ads.ts";
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
  ad_product: string;
  von: string | null;
  bis: string | null;
  tage: number | string;
}

const AD_PRODUCTS: AdProduct[] = ["SP", "SB", "SD"];

function adProductAus(x: unknown): AdProduct | null {
  const t = typeof x === "string" ? x.trim().toUpperCase() : "";
  return (AD_PRODUCTS as string[]).includes(t) ? (t as AdProduct) : null;
}

/**
 * Hinweise zur Abdeckung je Anzeigentyp: fehlt die Tagesreihe ganz oder reicht
 * sie nicht über den Zeitraum, steht es hier — statt dass Lücken wie Nullen
 * aussehen. Ohne Zeilen für einen Typ gibt es dazu keinen Hinweis: ein Konto
 * ohne Sponsored Brands hat nichts zu melden.
 */
export function abdeckungsHinweise(
  abdeckungen: Abdeckung[],
  tabelle: string,
  von: string,
  bis: string,
  was: string,
  nur: AdProduct | null,
): string[] {
  const passend = abdeckungen.filter((a) => a.tabelle === tabelle && (!nur || a.ad_product === nur));
  if (passend.length === 0 || passend.every((a) => !a.von || !a.bis || Number(a.tage) === 0)) {
    return [`Noch keine ${was}${nur ? ` für ${nur}` : ""} vorhanden — der Report ist für diesen Mandanten noch nicht gelaufen.`];
  }
  const h: string[] = [];
  for (const a of passend) {
    if (!a.von || !a.bis) continue;
    if (a.von > von) h.push(`${was} (${a.ad_product}) beginnen erst am ${a.von}.`);
    if (a.bis < bis) h.push(`${was} (${a.ad_product}) enden am ${a.bis}.`);
  }
  if (istVorlaeufig(bis)) {
    h.push(`Zeitraum reicht in die letzten ${VOLATIL_TAGE} Tage — Amazon passt die Zahlen noch an. Als vorläufig behandeln.`);
  }
  return h;
}

/** Attributionshinweis, wenn mehr als ein Anzeigentyp in der Antwort steckt. */
function attributionsHinweis(typen: Set<string>): string[] {
  const t = [...typen].sort();
  if (t.length === 0) return [];
  const teile = t.map((x) => `${x} ${ATTRIBUTION_TAGE[x as AdProduct] ?? "?"} Tage`);
  return t.length === 1
    ? [`Attribution: ${teile[0]} (Amazons Vorgabe für diesen Anzeigentyp).`]
    : [`Attribution je Anzeigentyp: ${teile.join(", ")} — Amazons Vorgabe, ACOS der Typen ist deshalb nicht gleichartig.`];
}

/**
 * Suchbegriffe: welche Suchanfragen über welches Keyword/Target Klicks und
 * Verkäufe brachten. Nach Spend sortiert, gedeckelt (limit, Default 500).
 * Optional auf eine Kampagne und/oder einen Anzeigentyp eingeschränkt.
 */
export async function adsSuchbegriffe(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown; campaign_id?: unknown; limit?: unknown; ad_product?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);
  const campaign = typeof opts?.campaign_id === "string" && opts.campaign_id.trim() ? opts.campaign_id.trim() : null;
  const limit = Number(opts?.limit) > 0 ? Math.min(Number(opts?.limit), 5000) : 500;
  const adProduct = adProductAus(opts?.ad_product);

  const [summenRes, abdeckungRes] = await Promise.all([
    supabase.rpc("ads_suchbegriffe_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis, p_campaign: campaign, p_limit: limit, p_ad_product: adProduct }),
    supabase.rpc("ads_tagesreihen_abdeckung", { p_tenant: tenant_id }),
  ]);
  if (summenRes.error) throw new Error(`ads_suchbegriffe_summen: ${summenRes.error.message}`);
  if (abdeckungRes.error) throw new Error(`ads_tagesreihen_abdeckung: ${abdeckungRes.error.message}`);

  const rows = (summenRes.data ?? []) as Array<Summen & {
    ad_product: string; campaign_id: string; campaign_name: string | null; ad_group_id: string; ad_group_name: string | null;
    ziel_id: string; ziel_text: string | null; match_type: string | null; suchbegriff: string; tage: number | string;
  }>;

  const suchbegriffe = rows.map((r) => ({
    adProduct: r.ad_product,
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

  const abdeckungen = (abdeckungRes.data ?? []) as Abdeckung[];

  return {
    zeitraum: { von, bis },
    kampagne: campaign,
    ad_product: adProduct,
    anzahl: suchbegriffe.length,
    gedeckelt: suchbegriffe.length >= limit,
    is_provisional: istVorlaeufig(bis),
    waehrungshinweis: "Beträge in der Währung des Werbeprofils.",
    suchbegriffe,
    formeln: FORMELN,
    hinweise: [
      ...abdeckungsHinweise(abdeckungen, "suchbegriffe", von, bis, "Suchbegriff-Daten", adProduct),
      ...attributionsHinweis(new Set(suchbegriffe.map((s) => s.adProduct))),
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
  opts?: { tage?: unknown; von?: unknown; bis?: unknown; ad_product?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);
  const adProduct = adProductAus(opts?.ad_product);

  const [summenRes, abdeckungRes] = await Promise.all([
    supabase.rpc("ads_placement_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis, p_ad_product: adProduct }),
    supabase.rpc("ads_tagesreihen_abdeckung", { p_tenant: tenant_id }),
  ]);
  if (summenRes.error) throw new Error(`ads_placement_summen: ${summenRes.error.message}`);
  if (abdeckungRes.error) throw new Error(`ads_tagesreihen_abdeckung: ${abdeckungRes.error.message}`);

  const rows = (summenRes.data ?? []) as Array<Summen & {
    ebene: string; ad_product: string; campaign_id: string | null; campaign_name: string | null; platzierung: string;
  }>;

  const gesamt = rows.filter((r) => r.ebene === "gesamt")
    .map((r) => ({ adProduct: r.ad_product, platzierung: r.platzierung, ...kennzahlenAusSummen(summen(r)) }))
    .sort((a, b) => b.spend - a.spend);

  const proKampagne = new Map<string, { adProduct: string; campaignId: string; campaignName: string | null; platzierungen: any[] }>();
  for (const r of rows.filter((x) => x.ebene === "kampagne")) {
    const id = `${r.ad_product}:${r.campaign_id ?? ""}`;
    let k = proKampagne.get(id);
    if (!k) {
      k = { adProduct: r.ad_product, campaignId: r.campaign_id ?? "", campaignName: r.campaign_name, platzierungen: [] };
      proKampagne.set(id, k);
    }
    k.platzierungen.push({ platzierung: r.platzierung, ...kennzahlenAusSummen(summen(r)) });
  }
  const kampagnen = [...proKampagne.values()]
    .map((k) => ({ ...k, platzierungen: k.platzierungen.sort((a, b) => b.spend - a.spend) }))
    .sort((a, b) => b.platzierungen.reduce((s, p) => s + p.spend, 0) - a.platzierungen.reduce((s, p) => s + p.spend, 0));

  const abdeckungen = (abdeckungRes.data ?? []) as Abdeckung[];

  return {
    zeitraum: { von, bis },
    ad_product: adProduct,
    is_provisional: istVorlaeufig(bis),
    waehrungshinweis: "Beträge in der Währung des Werbeprofils.",
    gesamt,
    proKampagne: kampagnen,
    formeln: FORMELN,
    hinweise: [
      ...abdeckungsHinweise(abdeckungen, "placement", von, bis, "Platzierungs-Daten", adProduct),
      ...attributionsHinweis(new Set(gesamt.map((g) => g.adProduct))),
      "Die aktuell gesetzten Modifier stehen im Struktur-Snapshot (get_ads_struktur) — dort vergleichen, " +
      "ob eine Platzierung mit gutem ACOS noch Luft nach oben hat.",
    ],
  };
}

/**
 * Ziele: Leistung je Keyword bzw. Product-Target über einen Zeitraum, dazu
 * Gebot und Zustand vom jüngsten Tag im Zeitraum. Das ist die Ebene, auf der
 * Gebote entschieden werden — und die Ebene, die die Bulk-Datei als „Keyword"
 * und „Produkt-Targeting" führte.
 */
export async function adsZiele(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown; campaign_id?: unknown; limit?: unknown; ad_product?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);
  const campaign = typeof opts?.campaign_id === "string" && opts.campaign_id.trim() ? opts.campaign_id.trim() : null;
  const limit = Number(opts?.limit) > 0 ? Math.min(Number(opts?.limit), 5000) : 500;
  const adProduct = adProductAus(opts?.ad_product);

  const [summenRes, abdeckungRes] = await Promise.all([
    supabase.rpc("ads_ziele_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis, p_campaign: campaign, p_limit: limit, p_ad_product: adProduct }),
    supabase.rpc("ads_tagesreihen_abdeckung", { p_tenant: tenant_id }),
  ]);
  if (summenRes.error) throw new Error(`ads_ziele_summen: ${summenRes.error.message}`);
  if (abdeckungRes.error) throw new Error(`ads_tagesreihen_abdeckung: ${abdeckungRes.error.message}`);

  const rows = (summenRes.data ?? []) as Array<Summen & {
    ad_product: string; campaign_id: string; campaign_name: string | null; ad_group_id: string; ad_group_name: string | null;
    ziel_id: string; text: string | null; match_type: string | null; gebot_cents: number | string | null; state: string | null; tage: number | string;
  }>;

  const ziele = rows.map((r) => ({
    adProduct: r.ad_product,
    zielId: r.ziel_id,
    text: r.text,
    matchType: r.match_type,
    gebot: r.gebot_cents === null || r.gebot_cents === undefined ? null : Number(r.gebot_cents) / 100,
    state: r.state,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    adGroupId: r.ad_group_id,
    adGroupName: r.ad_group_name,
    tage: Number(r.tage),
    ...kennzahlenAusSummen(summen(r)),
  }));

  const abdeckungen = (abdeckungRes.data ?? []) as Abdeckung[];

  return {
    zeitraum: { von, bis },
    kampagne: campaign,
    ad_product: adProduct,
    anzahl: ziele.length,
    gedeckelt: ziele.length >= limit,
    is_provisional: istVorlaeufig(bis),
    waehrungshinweis: "Beträge in der Währung des Werbeprofils.",
    ziele,
    formeln: FORMELN,
    hinweise: [
      ...abdeckungsHinweise(abdeckungen, "ziele", von, bis, "Ziel-Daten", adProduct),
      ...attributionsHinweis(new Set(ziele.map((z) => z.adProduct))),
      ...(ziele.length >= limit ? [`Liste auf ${limit} Einträge (nach Spend) gedeckelt — limit erhöhen oder campaign_id setzen.`] : []),
      "gebot und state sind der Stand des jüngsten Tages im Zeitraum, keine Summe. Die Historie je Tag liegt in ads_ziele_daily.",
    ],
  };
}

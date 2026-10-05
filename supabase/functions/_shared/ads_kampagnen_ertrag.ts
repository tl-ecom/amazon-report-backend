// ads_kampagnen_ertrag.ts — was je Kampagne nach Werbung übrig bleibt.
//
// Der ACoS einer Kampagne sagt allein nichts: 35 % sind bei 44 % Marge ein
// Gewinn und bei 30 % ein Verlust. Hier steht jede gesteuerte Kampagne gegen
// die Marge IHRES Produkts (ads_produkt_lage.ts: margeFuer).
//
// Gerechnet wird mit dem Werbeumsatz, den Amazon der Kampagne zuschreibt.
// Was eine Kampagne am organischen Rang bewegt, steht nicht darin — eine
// Ranking-Kampagne darf über dem Break-even liegen. Das ist eine Rechnung
// je Kampagne, kein Urteil.

import { marktplatzKopf } from "./ads_marktplatz.ts";
import { type AsinMarge, asinMargenAus, margeFuer } from "./ads_produkt_lage.ts";
import { produktUebersicht } from "./produkte.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Darunter ist eine Kampagne ohne Bestellung noch kein Befund. */
export const MIN_KLICKS = 20;

export interface SummenZeile {
  campaign_id: string; campaign_name: string | null; ad_product: string | null;
  produkt: string; modus: "h10" | "pulse";
  impressions: number | string; clicks: number | string;
  spend_cents: number | string; sales_cents: number | string; orders: number | string;
  tage_aktiv: number | string;
}

export type Einordnung = "traegt_sich" | "ueber_break_even" | "ohne_bestellung" | "wenig_daten" | "marge_unbekannt";

export function baueKampagnenErtrag(z: SummenZeile, marge: number | null) {
  const klicks = Number(z.clicks);
  const kosten = r2(Number(z.spend_cents) / 100);
  const umsatz = r2(Number(z.sales_cents) / 100);
  const bestellungen = Number(z.orders);
  const acos = umsatz > 0 ? Math.round((kosten / umsatz) * 10000) / 10000 : null;
  const einordnung: Einordnung =
    bestellungen === 0 ? (klicks >= MIN_KLICKS ? "ohne_bestellung" : "wenig_daten")
    : marge === null ? "marge_unbekannt"
    : acos! < marge ? "traegt_sich" : "ueber_break_even";
  return {
    campaignId: z.campaign_id, kampagne: z.campaign_name, typ: z.ad_product,
    produkt: z.produkt, steuerung: z.modus,
    tage_aktiv: Number(z.tage_aktiv), klicks, kosten, umsatz, bestellungen, acos,
    break_even_acos: marge,
    // Werbeumsatz x Marge − Kosten. Ohne Bestellung sind das schlicht die Kosten.
    // null ohne Marge, solange es Umsatz gibt — dann wäre es geraten.
    db_nach_werbung: umsatz === 0 ? r2(-kosten) : marge === null ? null : r2(umsatz * marge - kosten),
    einordnung,
  };
}

export function bilanzAus(kampagnen: ReturnType<typeof baueKampagnenErtrag>[]) {
  const von = (e: Einordnung) => kampagnen.filter((k) => k.einordnung === e);
  const db = (l: typeof kampagnen) => r2(l.reduce((n, k) => n + (k.db_nach_werbung ?? 0), 0));
  return {
    traegt_sich: { anzahl: von("traegt_sich").length, db_nach_werbung: db(von("traegt_sich")) },
    ueber_break_even: { anzahl: von("ueber_break_even").length, db_nach_werbung: db(von("ueber_break_even")) },
    ohne_bestellung: { anzahl: von("ohne_bestellung").length, kosten: r2(von("ohne_bestellung").reduce((n, k) => n + k.kosten, 0)) },
    wenig_daten: von("wenig_daten").length,
    marge_unbekannt: von("marge_unbekannt").length,
  };
}

export async function adsKampagnenErtrag(
  supabase: any, tenant_id: string, opts?: { tage?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const tage = Math.max(1, Math.min(Number(opts?.tage) || 30, 90));
  const [s, lage] = await Promise.all([
    supabase.rpc("ads_kampagnen_summen", { p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_tage: tage }),
    // ponytail: die Lage wird nur wegen der ASIN-Zuordnung je Produkt gelesen.
    // Wird das spürbar langsam, bekommt die Zuordnung eine eigene SQL-Funktion.
    supabase.rpc("ads_produkt_lage", { p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_tage: 7 }),
  ]);
  if (s.error) throw new Error("ads_kampagnen_summen: " + s.error.message);
  if (lage.error) throw new Error("ads_produkt_lage: " + lage.error.message);

  let margen = new Map<string, AsinMarge>();
  let margenFehler: string | null = null;
  try {
    const pu = await produktUebersicht(supabase, tenant_id, { tage: 90 }) as { produkte?: any[] };
    margen = asinMargenAus(pu?.produkte ?? []);
  } catch (e) {
    margenFehler = String((e as Error)?.message ?? e);
  }
  const asins = (lage.data?.asins ?? {}) as Record<string, string[]>;
  const margeJeProdukt = new Map<string, number | null>();
  const margeVon = (produkt: string) => {
    if (!margeJeProdukt.has(produkt)) margeJeProdukt.set(produkt, margeFuer(asins[produkt] ?? [], margen));
    return margeJeProdukt.get(produkt)!;
  };

  const kampagnen = ((s.data?.zeilen ?? []) as SummenZeile[])
    .map((z) => baueKampagnenErtrag(z, margeVon(z.produkt)))
    // Die größten Verluste zuerst; unbekannt ans Ende.
    .sort((a, b) => (a.db_nach_werbung ?? Infinity) - (b.db_nach_werbung ?? Infinity));

  return {
    ...kopf,
    tage,
    daten_bis: s.data?.letzter_tag ?? null,
    schwelle_klicks: MIN_KLICKS,
    bilanz: bilanzAus(kampagnen),
    kampagnen,
    hinweise: [
      `Letzte ${tage} Tage mit Ads-Daten (bis ${s.data?.letzter_tag ?? "—"}). \`db_nach_werbung\` = Werbeumsatz der `
      + "Kampagne x Marge vor Werbung des Produkts − Werbekosten. `break_even_acos` ist diese Marge (90 Tage, "
      + "nach Umsatz gewichtet): liegt der ACoS darüber, kostet die Kampagne mehr, als ihr Werbeumsatz abwirft.",
      "Nur der Werbeumsatz, den Amazon der Kampagne zuschreibt. Was sie am organischen Rang bewegt, steht "
      + "nicht darin — eine Ranking-Kampagne darf über dem Break-even liegen. Sponsored Brands und Display "
      + "schreiben Umsatz anders zu als Sponsored Products; ihr ACoS ist nicht eins zu eins vergleichbar.",
      `\`ohne_bestellung\` erst ab ${MIN_KLICKS} Klicks; darunter \`wenig_daten\`. \`marge_unbekannt\`: Amazon hat für `
      + "das Produkt noch kaum Gebühren abgerechnet.",
      "`steuerung` h10: die Gebote setzt Helium 10. Budget, Zustand und Negatives bleiben über Pulse möglich.",
      ...(margenFehler ? ["Margen nicht lesbar: " + margenFehler] : []),
    ],
  };
}

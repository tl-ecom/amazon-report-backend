// ads_kandidaten.ts — aus Suchbegriffen werden Handlungskandidaten.
//
// Die Frage dahinter: wofür wird Geld ausgegeben, das nichts bringt — und was
// bringt Bestellungen, ohne ein eigenes Keyword zu haben. Der Ads-Changelog
// hat bei Vaneja gezeigt, dass Gebotsänderungen etwa so oft besser wie
// schlechter ausgehen; der Hebel liegt eher darin, WOFÜR geboten wird.
//
// Die Rohlage kommt aus der SQL-Funktion ads_suchbegriff_kandidaten. Hier wird
// nur eingeordnet — rein und testbar.
//
// DREI DINGE, die die Liste ehrlich halten:
//
// 1. ZUFALL. Null Bestellungen bei zehn Klicks sind bei 11 % Konto-CVR in
//    rund 31 % der Fälle schlicht Pech. Jede Zeile trägt deshalb
//    `zufall_prozent`: wie wahrscheinlich das Ergebnis wäre, wenn der Begriff
//    so gut liefe wie der Kontoschnitt. Kein Urteil, eine Einordnung.
//
// 2. DAS ZIEL SELBST. Läuft "koch chemie" über das Exact-Keyword "koch chemie"
//    schlecht, ist ein Negative die falsche Antwort — man prüft das Keyword.
//    Solche Zeilen bekommen `aktion: "ziel_pruefen"`.
//
// 3. ANDERSWO ERFOLGREICH. Ein Begriff kann in einer Gruppe nichts bringen und
//    in einer anderen verkaufen. `bestellungen_anderswo` zeigt das, bevor
//    jemand ihn kontoweit ausschließt.
//
// ponytail: Zufall rechnet mit der Konto-CVR, nicht mit der CVR der Gruppe
// oder des Produkts. Für teure Nischenprodukte ist das zu streng. Umstellen
// auf Gruppen-CVR, wenn die Liste dort sichtbar danebenliegt.

import { marktplatzKopf } from "./ads_marktplatz.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

export const MIN_KLICKS = 10;
export const MIN_BESTELLUNGEN = 2;

export interface KandidatZeile {
  campaign_id: string; campaign_name: string | null;
  ad_group_id: string; ad_group_name: string | null;
  suchbegriff: string; match_types: string[];
  impressions: number; clicks: number; spend_cents: number; sales_cents: number; orders: number;
  asins: string[];
  negativ_vorhanden: boolean;
  ist_ziel_der_gruppe: boolean;
  exact_im_konto: "aktiv" | "pausiert" | null;
}

/** Suchbegriffe, die eine ASIN sind, kommen aus Produkt-Targeting — dort hilft kein Keyword. */
export function istAsin(s: string): boolean {
  return /^b0[a-z0-9]{8}$/i.test(s);
}

/**
 * Wahrscheinlichkeit in Prozent, bei `klicks` Klicks keine Bestellung zu
 * sehen, wenn der Begriff mit der Konto-CVR liefe. null ohne CVR.
 */
export function zufallProzent(klicks: number, cvr: number | null): number | null {
  if (cvr === null || !(cvr > 0) || cvr >= 1) return null;
  return Math.round(Math.pow(1 - cvr, klicks) * 1000) / 10;
}

export interface NegativKandidat {
  suchbegriff: string;
  typ: "suchbegriff" | "asin";
  /** negativ_anlegen = als Negative in dieser Gruppe; ziel_pruefen = der Begriff ist selbst das Ziel. */
  aktion: "negativ_anlegen" | "ziel_pruefen";
  campaignId: string; campaignName: string | null;
  adGroupId: string; adGroupName: string | null;
  quelle: string[];
  klicks: number; impressions: number; kosten: number;
  zufall_prozent: number | null;
  /** Bestellungen desselben Begriffs in ANDEREN Anzeigengruppen im Zeitraum. */
  bestellungen_anderswo: number;
  asins: string[];
}

export interface ErnteKandidat {
  suchbegriff: string;
  klicks: number; kosten: number; umsatz: number; bestellungen: number;
  acos: number | null; cvr: number | null;
  /** Bisheriger Klickpreis — als Startgebot brauchbar, kein Zielgebot. */
  cpc: number | null;
  /** Es gibt das Exact-Keyword schon, aber pausiert. */
  exact_pausiert: boolean;
  quellen: Array<{ campaignName: string | null; adGroupName: string | null; matchTypes: string[]; bestellungen: number }>;
}

export function baueNegativKandidaten(
  zeilen: KandidatZeile[], cvrKonto: number | null, minKlicks = MIN_KLICKS,
): NegativKandidat[] {
  const bestellungenJeBegriff = new Map<string, number>();
  for (const z of zeilen) bestellungenJeBegriff.set(z.suchbegriff, (bestellungenJeBegriff.get(z.suchbegriff) ?? 0) + Number(z.orders));

  return zeilen
    .filter((z) => Number(z.orders) === 0 && Number(z.clicks) >= minKlicks && !z.negativ_vorhanden)
    .map((z): NegativKandidat => ({
      suchbegriff: z.suchbegriff,
      typ: istAsin(z.suchbegriff) ? "asin" : "suchbegriff",
      aktion: z.ist_ziel_der_gruppe ? "ziel_pruefen" : "negativ_anlegen",
      campaignId: z.campaign_id, campaignName: z.campaign_name,
      adGroupId: z.ad_group_id, adGroupName: z.ad_group_name,
      quelle: z.match_types ?? [],
      klicks: Number(z.clicks), impressions: Number(z.impressions), kosten: r2(Number(z.spend_cents) / 100),
      zufall_prozent: zufallProzent(Number(z.clicks), cvrKonto),
      // Diese Zeile selbst hat null Bestellungen, die Summe ist also "anderswo".
      bestellungen_anderswo: bestellungenJeBegriff.get(z.suchbegriff) ?? 0,
      asins: z.asins ?? [],
    }))
    .sort((a, b) => b.kosten - a.kosten);
}

/**
 * Begriffe mit Bestellungen ohne aktives Exact-Keyword im Konto. Je Begriff
 * über alle Gruppen summiert — geerntet wird ein Begriff, nicht eine Zeile.
 * ASINs bleiben draußen: dafür gibt es kein Keyword.
 */
export function baueErnteKandidaten(zeilen: KandidatZeile[], minBestellungen = MIN_BESTELLUNGEN): ErnteKandidat[] {
  const je = new Map<string, KandidatZeile[]>();
  for (const z of zeilen) {
    if (Number(z.orders) < 1 || istAsin(z.suchbegriff) || z.exact_im_konto === "aktiv") continue;
    const liste = je.get(z.suchbegriff) ?? [];
    liste.push(z);
    je.set(z.suchbegriff, liste);
  }
  const out: ErnteKandidat[] = [];
  for (const [suchbegriff, liste] of je) {
    const summe = (f: (z: KandidatZeile) => number) => liste.reduce((n, z) => n + Number(f(z)), 0);
    const bestellungen = summe((z) => z.orders);
    if (bestellungen < minBestellungen) continue;
    const klicks = summe((z) => z.clicks);
    const kosten = r2(summe((z) => z.spend_cents) / 100);
    const umsatz = r2(summe((z) => z.sales_cents) / 100);
    out.push({
      suchbegriff, klicks, kosten, umsatz, bestellungen,
      acos: umsatz > 0 ? Math.round((kosten / umsatz) * 10000) / 10000 : null,
      cvr: klicks > 0 ? Math.round((bestellungen / klicks) * 10000) / 10000 : null,
      cpc: klicks > 0 ? r2(kosten / klicks) : null,
      exact_pausiert: liste.some((z) => z.exact_im_konto === "pausiert"),
      quellen: liste
        .map((z) => ({ campaignName: z.campaign_name, adGroupName: z.ad_group_name, matchTypes: z.match_types ?? [], bestellungen: Number(z.orders) }))
        .sort((a, b) => b.bestellungen - a.bestellungen),
    });
  }
  return out.sort((a, b) => b.bestellungen - a.bestellungen || b.umsatz - a.umsatz);
}

/**
 * Suchbegriffe der Anzeigengruppen, die diese ASIN bewerben. `eindeutig` sagt,
 * ob die Gruppe NUR diese ASIN bewirbt — sonst gehört der Begriff mehreren
 * Produkten zugleich, und Amazon verrät nicht, welchem.
 */
export function begriffeFuerAsin(zeilen: KandidatZeile[], asin: string) {
  const a = asin.trim().toUpperCase();
  return zeilen
    .filter((z) => (z.asins ?? []).some((x) => x.toUpperCase() === a))
    .map((z) => {
      const kosten = r2(Number(z.spend_cents) / 100);
      const umsatz = r2(Number(z.sales_cents) / 100);
      return {
        suchbegriff: z.suchbegriff,
        campaignName: z.campaign_name, adGroupName: z.ad_group_name,
        klicks: Number(z.clicks), kosten, umsatz, bestellungen: Number(z.orders),
        acos: umsatz > 0 ? Math.round((kosten / umsatz) * 10000) / 10000 : null,
        eindeutig: (z.asins ?? []).length === 1,
        weitere_asins: (z.asins ?? []).filter((x) => x.toUpperCase() !== a),
      };
    })
    .sort((x, y) => y.kosten - x.kosten);
}

function tag(x: unknown): string | null {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
}

export async function adsKandidaten(
  supabase: any,
  tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; min_klicks?: unknown; min_bestellungen?: unknown; asin?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const von = tag(opts?.von) ?? new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const bis = tag(opts?.bis) ?? new Date().toISOString().slice(0, 10);
  const minKlicks = Math.max(1, Math.min(Number(opts?.min_klicks) || MIN_KLICKS, 1000));
  const minBestellungen = Math.max(1, Math.min(Number(opts?.min_bestellungen) || MIN_BESTELLUNGEN, 1000));
  const asin = typeof opts?.asin === "string" && opts.asin.trim() ? opts.asin.trim().toUpperCase() : null;

  const { data, error } = await supabase.rpc("ads_suchbegriff_kandidaten", {
    p_tenant: tenant_id, p_von: von, p_bis: bis, p_marktplatz: kopf.marktplatz, p_min_klicks: minKlicks,
  });
  if (error) throw new Error(`ads_suchbegriff_kandidaten: ${error.message}`);

  const zeilen = ((data?.zeilen ?? []) as KandidatZeile[]);
  const k = data?.konto ?? {};
  const klicks = Number(k.clicks) || 0;
  const bestellungen = Number(k.orders) || 0;
  const cvr = klicks > 0 ? bestellungen / klicks : null;

  const negativ = baueNegativKandidaten(zeilen, cvr, minKlicks);
  const ernte = baueErnteKandidaten(zeilen, minBestellungen);
  const anlegen = negativ.filter((n) => n.aktion === "negativ_anlegen");

  return {
    ...kopf,
    zeitraum: { von, bis },
    stand_struktur: data?.stand ?? null,
    schwellen: { min_klicks: minKlicks, min_bestellungen: minBestellungen },
    konto: {
      suchbegriffe: Number(k.begriffe) || 0, klicks, bestellungen,
      kosten: r2((Number(k.spend_cents) || 0) / 100),
      cvr: cvr === null ? null : Math.round(cvr * 10000) / 10000,
    },
    bilanz: {
      negativ_anlegen: { anzahl: anlegen.length, kosten: r2(anlegen.reduce((n, x) => n + x.kosten, 0)) },
      ziel_pruefen: {
        anzahl: negativ.length - anlegen.length,
        kosten: r2(negativ.filter((n) => n.aktion === "ziel_pruefen").reduce((n, x) => n + x.kosten, 0)),
      },
      ernte: { anzahl: ernte.length, bestellungen: ernte.reduce((n, x) => n + x.bestellungen, 0) },
    },
    negativ_kandidaten: negativ,
    ernte_kandidaten: ernte,
    ...(asin ? { asin: { asin, begriffe: begriffeFuerAsin(zeilen, asin) } } : {}),
    hinweise: [
      "Nur Sponsored Products: für Sponsored Brands kennt der Struktur-Snapshot die Ziele nicht — "
      + "ob ein Begriff dort schon ausgeschlossen ist, ließe sich nicht sagen.",
      "`zufall_prozent` sagt, wie oft null Bestellungen bei dieser Klickzahl reiner Zufall wären, "
      + "wenn der Begriff so gut liefe wie der Kontoschnitt. Unter etwa 10 % ist das Ergebnis "
      + "belastbar; darüber ist Abwarten oft die bessere Entscheidung.",
      "`bestellungen_anderswo` > 0: der Begriff verkauft in einer anderen Anzeigengruppe. "
      + "Ein Negative gilt nur für die genannte Gruppe.",
      "Ernte: `cpc` ist der bisherige Klickpreis und taugt als Startgebot, nicht als Zielgebot. "
      + "ASIN-Suchbegriffe stehen nicht in der Ernte — dafür gibt es kein Keyword.",
      "Vorhandene Negatives und Keywords stammen aus dem Struktur-Snapshot (`stand_struktur`). "
      + "Was danach angelegt wurde, kennt die Liste noch nicht.",
      ...(asin
        ? ["`eindeutig: false` heißt: die Anzeigengruppe bewirbt mehrere ASINs. Amazon meldet "
          + "Suchbegriffe je Gruppe, nicht je Produkt — der Begriff gehört dann allen zugleich."]
        : []),
    ],
  };
}

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
import { ladeSteuerung, type Modus } from "./ads_steuerung.ts";
import { geschaetzteCvr, MIN_GEBOT_AMAZON } from "./gebotsautomatik.ts";
import { produktUebersicht } from "./produkte.ts";

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
  quellen: Array<{ campaignId: string; campaignName: string | null; adGroupName: string | null; matchTypes: string[]; bestellungen: number }>;
  /** ASINs der Anzeigengruppen, über die der Begriff Bestellungen brachte. */
  asins: string[];
}

/** Was die Produktübersicht je ASIN an Marge und Ziel hergibt. */
export interface ProduktMarge {
  produktname: string | null;
  /**
   * Deckungsbeitrag vor Werbung je Euro BRUTTO-Umsatz (Anteil, nicht Prozent).
   * Brutto, weil Amazons ACoS am Bruttoumsatz gemessen wird — der Break-even
   * der Produktübersicht steht auf Netto und wäre hier um den Steuersatz zu hoch.
   */
  break_even: number | null;
  /** Vom Coach gesetztes Ziel je ASIN (Anteil). null = keins gesetzt. */
  ziel_acos: number | null;
}

export interface GeschaerfterKandidat extends ErnteKandidat {
  produkt: string | null;
  /** false = der Begriff lief über Gruppen mit mehreren ASINs; gerechnet wird dann mit der schwächsten Marge. */
  asin_eindeutig: boolean;
  break_even_acos: number | null;
  ziel_acos: number | null;
  /** Deckungsbeitrag nach Werbung im Zeitraum: Umsatz x Break-even minus Kosten. null ohne Marge. */
  gewinn_nach_werbung: number | null;
  einordnung: "traegt_sich" | "ueber_break_even" | "marge_unbekannt";
  /** Umsatz je Bestellung x Ziel-ACoS x geschätzte CVR. null ohne Ziel und ohne Marge. */
  zielgebot: number | null;
  /** Worauf das Zielgebot zielt. break_even heißt: bei diesem Gebot bleibt nichts übrig. */
  zielgebot_basis: "ziel_acos" | "break_even" | null;
  cvr_geschaetzt: number | null;
}

/**
 * Macht aus der Ernte-Liste eine Rangfolge nach dem, was übrig bleibt.
 *
 * Vorher stand sie nach Bestellungen sortiert, und "warnweste kinder 6-12
 * jahre" mit 10 Bestellungen bei 76 % ACoS stand weit oben. Bestellungen sind
 * kein Grund zu ernten; Deckungsbeitrag ist einer.
 *
 * Das Zielgebot folgt der Gebotsautomatik (Umsatz je Bestellung x Ziel-ACoS x
 * CVR), mit derselben CVR-Schätzung: der Prior sitzt hier auf der Konto-CVR,
 * weil das neue Keyword noch keine Anzeigengruppe hat.
 *
 * ponytail: ohne Platzierungs-Aufschlag — der hängt an der Kampagne, in der das
 * Keyword landet, und die steht noch nicht fest. Liegt dort ein Aufschlag auf
 * Top of Search, ist das Zielgebot um diesen Faktor zu hoch.
 */
export function schaerfeErnte(
  ernte: ErnteKandidat[],
  produkte: Map<string, ProduktMarge>,
  konto: { klicks: number; bestellungen: number },
): GeschaerfterKandidat[] {
  return ernte.map((e): GeschaerfterKandidat => {
    const bekannt = e.asins.map((a) => produkte.get(a.toUpperCase())).filter((p): p is ProduktMarge => !!p);
    const mitMarge = bekannt.filter((p) => p.break_even !== null);
    // Mehrere ASINs: die schwächste Marge. Lieber einen guten Kandidaten zu
    // streng bewerten als einen schlechten durchwinken.
    const be = mitMarge.length ? Math.min(...mitMarge.map((p) => p.break_even!)) : null;
    const ziele = bekannt.map((p) => p.ziel_acos).filter((z): z is number => z !== null);
    const ziel = ziele.length ? Math.min(...ziele) : null;
    const eindeutig = e.asins.length === 1;

    const cvr = geschaetzteCvr({ klicks: e.klicks, bestellungen: e.bestellungen }, konto).genutzt;
    const basisWert = ziel ?? be;
    const jeBestellung = e.bestellungen > 0 ? e.umsatz / e.bestellungen : null;
    const roh = basisWert !== null && basisWert > 0 && cvr !== null && jeBestellung !== null
      ? jeBestellung * basisWert * cvr : null;

    return {
      ...e,
      produkt: eindeutig ? (bekannt[0]?.produktname ?? null) : null,
      asin_eindeutig: eindeutig,
      break_even_acos: be === null ? null : Math.round(be * 10000) / 10000,
      ziel_acos: ziel,
      gewinn_nach_werbung: be === null ? null : r2(e.umsatz * be - e.kosten),
      einordnung: be === null || e.acos === null ? "marge_unbekannt" : e.acos < be ? "traegt_sich" : "ueber_break_even",
      zielgebot: roh === null ? null : Math.max(MIN_GEBOT_AMAZON, r2(roh)),
      zielgebot_basis: roh === null ? null : ziel !== null ? "ziel_acos" : "break_even",
      cvr_geschaetzt: cvr,
    };
  }).sort((a, b) =>
    (b.gewinn_nach_werbung ?? -Infinity) - (a.gewinn_nach_werbung ?? -Infinity) || b.bestellungen - a.bestellungen
  );
}

export interface ExactGruppe {
  campaign_id: string; campaign_name: string | null; ad_group_id: string;
  exact_keywords: number; asins: string[];
}

export interface Anlage {
  campaignId: string; campaignName: string | null; adGroupId: string;
  steuerung: Modus;
  /** Wie viele andere Exact-Gruppen desselben Produkts es noch gäbe — die Wahl ist ein Vorschlag. */
  alternativen: number;
  startgebot: number | null;
  /** Das Startgebot liegt unter dem bisher gezahlten Klickpreis: das Keyword gewinnt die Auktion dann oft nicht. */
  unter_klickpreis: boolean;
}

/**
 * Wohin mit dem geernteten Begriff: die laufende Exact-Gruppe, die eine seiner
 * ASINs bewirbt und die meisten Exact-Keywords hat — dort wird schon gesammelt.
 * Nur Kampagnen, an denen Pulse schreiben darf. null, wenn es keine gibt.
 *
 * Startgebot wie in der Anzeige: mit Ziel-ACoS das Zielgebot, sonst der
 * bisherige Klickpreis. Vanejas "kratzbrett l form" wurde mit 0,71 EUR
 * geerntet, der Begriff kostete davor 1,21 EUR — und brach ein.
 *
 * ponytail: "meiste Exact-Keywords" ist eine Faustregel, kein Wissen über die
 * Kontostruktur. Gibt es je Produkt eine feste Ernte-Kampagne, gehört sie in
 * eine Spalte von ads_steuerung.
 */
export function anlageFuer(
  e: Pick<GeschaerfterKandidat, "asins" | "cpc" | "zielgebot" | "zielgebot_basis">,
  gruppen: ExactGruppe[],
  modusVon: (campaignId: string) => Modus,
): Anlage | null {
  const asins = new Set(e.asins.map((a) => a.toUpperCase()));
  const passend = gruppen
    .filter((g) => modusVon(g.campaign_id) !== "nur_analyse" && (g.asins ?? []).some((a) => asins.has(a.toUpperCase())))
    .sort((a, b) => Number(b.exact_keywords) - Number(a.exact_keywords));
  const g = passend[0];
  if (!g) return null;
  const startgebot = e.zielgebot_basis === "ziel_acos" ? e.zielgebot : e.cpc;
  return {
    campaignId: g.campaign_id, campaignName: g.campaign_name, adGroupId: g.ad_group_id,
    steuerung: modusVon(g.campaign_id), alternativen: passend.length - 1,
    startgebot: startgebot === null ? null : Math.max(MIN_GEBOT_AMAZON, startgebot),
    unter_klickpreis: startgebot !== null && e.cpc !== null && startgebot < e.cpc,
  };
}

/** Aus der Produktübersicht wird die Margen-Tabelle je ASIN. */
export function margenAus(produkte: any[]): Map<string, ProduktMarge> {
  const m = new Map<string, ProduktMarge>();
  for (const p of produkte ?? []) {
    const brutto = Number(p?.umsatz_brutto);
    const vor = p?.nettogewinn_vor_werbung;
    m.set(String(p.asin).toUpperCase(), {
      produktname: p.produktname ?? null,
      break_even: vor !== null && vor !== undefined && brutto > 0 ? Number(vor) / brutto : null,
      ziel_acos: p?.ziel_acos_prozent === null || p?.ziel_acos_prozent === undefined ? null : Number(p.ziel_acos_prozent) / 100,
    });
  }
  return m;
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
        .map((z) => ({ campaignId: z.campaign_id, campaignName: z.campaign_name, adGroupName: z.ad_group_name, matchTypes: z.match_types ?? [], bestellungen: Number(z.orders) }))
        .sort((a, b) => b.bestellungen - a.bestellungen),
      asins: [...new Set(liste.flatMap((z) => z.asins ?? []))].sort(),
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

  const modusVon = await ladeSteuerung(supabase, tenant_id);
  const negativ = baueNegativKandidaten(zeilen, cvr, minKlicks).map((n) => ({ ...n, steuerung: modusVon(n.campaignId) }));
  const ernteRoh = baueErnteKandidaten(zeilen, minBestellungen);
  // Margen nur holen, wenn es etwas zu bewerten gibt. 90 Tage: lang genug, dass
  // Amazons verzögerte Gebührenabrechnung die Marge nicht verzerrt.
  let margen = new Map<string, ProduktMarge>();
  let margenFehler: string | null = null;
  if (ernteRoh.length > 0) {
    try {
      const pu = await produktUebersicht(supabase, tenant_id, { tage: 90 }) as { produkte?: any[] };
      margen = margenAus(pu?.produkte ?? []);
    } catch (e) {
      // Die Liste bleibt brauchbar, nur eben ohne Rangfolge nach Deckungsbeitrag.
      margenFehler = String((e as Error)?.message ?? e);
    }
  }
  let gruppen: ExactGruppe[] = [];
  if (ernteRoh.length > 0) {
    const g = await supabase.rpc("ads_exact_gruppen", { p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_von: von, p_bis: bis });
    if (g.error) throw new Error(`ads_exact_gruppen: ${g.error.message}`);
    gruppen = (g.data ?? []) as ExactGruppe[];
  }
  // Ein Begriff zaehlt als gesteuert, sobald eine seiner Quell-Kampagnen es ist.
  const ernte = schaerfeErnte(ernteRoh, margen, { klicks, bestellungen }).map((e) => ({
    ...e, steuerung: e.quellen.map((q) => modusVon(q.campaignId)).find((m) => m !== "nur_analyse") ?? "nur_analyse",
    anlage: anlageFuer(e, gruppen, modusVon),
  }));
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
      ernte: {
        anzahl: ernte.length, bestellungen: ernte.reduce((n, x) => n + x.bestellungen, 0),
        traegt_sich: ernte.filter((x) => x.einordnung === "traegt_sich").length,
        ueber_break_even: ernte.filter((x) => x.einordnung === "ueber_break_even").length,
        marge_unbekannt: ernte.filter((x) => x.einordnung === "marge_unbekannt").length,
      },
    },
    negativ_kandidaten: negativ,
    ernte_kandidaten: ernte,
    ...(asin ? { asin: { asin, begriffe: begriffeFuerAsin(zeilen, asin) } } : {}),
    hinweise: [
      "`anlage` je Ernte-Kandidat ist ein Vorschlag: die laufende Exact-Anzeigengruppe desselben Produkts mit den "
      + "meisten Exact-Keywords und ein Startgebot. `alternativen` > 0 heißt, es gäbe weitere passende Gruppen. "
      + "Das Negative in der Quelle gehört NICHT zum ersten Schritt: erst wenn das neue Keyword Klicks holt.",
      "`steuerung` je Zeile: `pulse` = Pulse steuert die Kampagne, `h10` = die Gebote setzt Helium 10 "
      + "(Negatives und neue Keywords bleiben möglich), `nur_analyse` = kein verwaltetes Produkt, nichts anfassen.",
      "Nur Sponsored Products: für Sponsored Brands kennt der Struktur-Snapshot die Ziele nicht — "
      + "ob ein Begriff dort schon ausgeschlossen ist, ließe sich nicht sagen.",
      "`zufall_prozent` sagt, wie oft null Bestellungen bei dieser Klickzahl reiner Zufall wären, "
      + "wenn der Begriff so gut liefe wie der Kontoschnitt. Unter etwa 10 % ist das Ergebnis "
      + "belastbar; darüber ist Abwarten oft die bessere Entscheidung.",
      "`bestellungen_anderswo` > 0: der Begriff verkauft in einer anderen Anzeigengruppe. "
      + "Ein Negative gilt nur für die genannte Gruppe.",
      "Ernte, sortiert nach `gewinn_nach_werbung`: Umsatz des Begriffs mal Break-even minus "
      + "Werbekosten. Der Break-even ist hier der Deckungsbeitrag vor Werbung je Euro "
      + "BRUTTO-Umsatz (90 Tage), weil Amazons ACoS am Bruttoumsatz hängt — er liegt deshalb "
      + "unter dem Break-even der Produktübersicht, der auf Netto steht.",
      "`zielgebot` = Umsatz je Bestellung x Ziel-ACoS x geschätzte CVR, wie in der Gebotsautomatik, "
      + "ohne Platzierungs-Aufschlag. NUR bei `zielgebot_basis: ziel_acos` ist es ein Vorschlag. Bei "
      + "`break_even` ist es die rechnerische Obergrenze, bei der nichts übrig bleibt — bei Begriffen "
      + "mit sehr niedrigem ACoS liegt sie weit über jedem sinnvollen Gebot (Vaneja: 8,45 € für "
      + "einen Begriff, der bisher 0,77 € je Klick kostete). Dann mit `cpc`, dem bisherigen "
      + "Klickpreis, starten und einen Ziel-ACoS für das Produkt setzen.",
      "`asin_eindeutig: false`: der Begriff lief über Gruppen mit mehreren ASINs. Gerechnet wird "
      + "dann mit der schwächsten Marge. `marge_unbekannt`: Einkaufspreis oder Gebühren fehlen.",
      "ASIN-Suchbegriffe stehen nicht in der Ernte — dafür gibt es kein Keyword.",
      ...(margenFehler ? [`Margen konnten nicht gelesen werden (${margenFehler}) — die Ernte ist unbewertet.`] : []),
      "Vorhandene Negatives und Keywords stammen aus dem Struktur-Snapshot (`stand_struktur`). "
      + "Was danach angelegt wurde, kennt die Liste noch nicht.",
      ...(asin
        ? ["`eindeutig: false` heißt: die Anzeigengruppe bewirbt mehrere ASINs. Amazon meldet "
          + "Suchbegriffe je Gruppe, nicht je Produkt — der Begriff gehört dann allen zugleich."]
        : []),
    ],
  };
}

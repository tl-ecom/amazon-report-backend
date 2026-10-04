// ads_struktur.ts — Aufbau des Werbekontos als Tabellenzeilen (reines Modul).
//
// Das ist der Ersatz für die Bulk-Datei aus der Werbekonsole: Kampagnen mit
// Tagesbudget und Platzierungs-Modifiern, Anzeigengruppen mit Standardgebot,
// Keywords und Product-Targets mit Gebot und Zustand, Negatives auf beiden
// Ebenen. Alles, was die Ads-API über die /list-Endpunkte hergibt.
//
// Kein Netz, keine DB. Die Function sync-ads-struktur holt die Rohobjekte und
// ruft hier die Zeilenbauer; der Leser adsStruktur() fasst die DB an, sonst
// nichts.
//
// SNAPSHOT-LOGIK: Jeder Lauf schreibt alle Zeilen mit demselben gesehen_am.
// Was Amazon nicht mehr liefert (archiviert, gelöscht), bekommt keinen neuen
// Stempel und fällt beim Lesen aus dem aktuellen Stand — ohne Löschen, die
// letzte bekannte Fassung bleibt als Spur stehen.
//
// GELD in ganzen Cent, wie überall im Backend. Die Währung ist die des
// Werbeprofils und steht nicht in den Objekten.

import { targetText } from "./gebote.ts";
import { marktplatzKopf } from "./ads_marktplatz.ts";

/** Objektarten in ads_ziele. Keyword- und Target-IDs kommen aus getrennten
 *  Namensräumen bei Amazon; die Art gehört deshalb in den Schlüssel. */
export type ZielArt =
  | "keyword"
  | "target"
  | "negativ_keyword"
  | "negativ_target"
  | "kampagne_negativ_keyword"
  | "kampagne_negativ_target";

export interface StrukturRohdaten {
  kampagnen: any[];
  anzeigengruppen: any[];
  keywords: any[];
  targets: any[];
  negativeKeywords: any[];
  negativeTargets: any[];
  kampagnenNegativeKeywords: any[];
  kampagnenNegativeTargets: any[];
}

/** Amazons Platzierungsnamen → Spaltenname. Unbekannte Platzierungen werden
 *  nicht erraten, sondern bleiben im JSON-Rohfeld erhalten. */
const PLATZIERUNG_SPALTE: Record<string, string> = {
  PLACEMENT_TOP: "mod_top_prozent",
  PLACEMENT_PRODUCT_PAGE: "mod_produktseite_prozent",
  PLACEMENT_REST_OF_SEARCH: "mod_rest_prozent",
};

function cents(x: unknown): number | null {
  const n = Number(x);
  return x === null || x === undefined || !Number.isFinite(n) ? null : Math.round(n * 100);
}

function s(x: unknown): string {
  return x === null || x === undefined ? "" : String(x).trim();
}

function datum(x: unknown): string | null {
  const t = s(x);
  // Amazon liefert teils YYYYMMDD (alt), teils YYYY-MM-DD.
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

export function baueKampagnenRows(tenant_id: string, kampagnen: any[], gesehen_am: string, marktplatz = "A1PA6795UKMFR9") {
  const out: Record<string, unknown>[] = [];
  for (const c of kampagnen) {
    const id = s(c?.campaignId);
    if (!id) continue;
    const mods: Record<string, number | null> = {
      mod_top_prozent: null,
      mod_produktseite_prozent: null,
      mod_rest_prozent: null,
    };
    const roh = Array.isArray(c?.dynamicBidding?.placementBidding) ? c.dynamicBidding.placementBidding : [];
    for (const p of roh) {
      const spalte = PLATZIERUNG_SPALTE[s(p?.placement)];
      const wert = Number(p?.percentage);
      if (spalte && Number.isFinite(wert)) mods[spalte] = Math.round(wert);
    }
    out.push({
      tenant_id,
      campaign_id: id,
      name: s(c?.name) || null,
      state: s(c?.state) || null,
      targeting_typ: s(c?.targetingType) || null,
      budget_cents: cents(c?.budget?.budget),
      budget_typ: s(c?.budget?.budgetType) || null,
      gebots_strategie: s(c?.dynamicBidding?.strategy) || null,
      ...mods,
      platzierungen_roh: roh.length ? roh : null,
      start_datum: datum(c?.startDate),
      end_datum: datum(c?.endDate),
      gesehen_am,
      marktplatz,
    });
  }
  return out;
}

export function baueAnzeigengruppenRows(tenant_id: string, gruppen: any[], gesehen_am: string, marktplatz = "A1PA6795UKMFR9") {
  const out: Record<string, unknown>[] = [];
  for (const g of gruppen) {
    const id = s(g?.adGroupId);
    if (!id) continue;
    out.push({
      tenant_id,
      ad_group_id: id,
      campaign_id: s(g?.campaignId),
      name: s(g?.name) || null,
      state: s(g?.state) || null,
      standard_gebot_cents: cents(g?.defaultBid),
      gesehen_am,
      marktplatz,
    });
  }
  return out;
}

/**
 * Keywords, Targets und Negatives → ads_ziele. Ein Gebot von null heißt:
 * erbt das Standardgebot der Anzeigengruppe — das ist eine echte Information
 * und wird nicht durch das Standardgebot ersetzt. Wer den Effektivwert will,
 * rechnet ihn beim Lesen aus beidem.
 */
export function baueZieleRows(tenant_id: string, roh: StrukturRohdaten, gesehen_am: string, marktplatz = "A1PA6795UKMFR9") {
  const out: Record<string, unknown>[] = [];

  const zeile = (
    art: ZielArt,
    id: string,
    x: any,
    text: string,
    matchType: string,
    gebot: number | null,
  ) => {
    if (!id) return;
    out.push({
      tenant_id,
      art,
      ziel_id: id,
      campaign_id: s(x?.campaignId),
      ad_group_id: s(x?.adGroupId),
      text: text || null,
      match_type: matchType || null,
      state: s(x?.state) || null,
      gebot_cents: gebot,
      gesehen_am,
      marktplatz,
    });
  };

  for (const k of roh.keywords) {
    zeile("keyword", s(k?.keywordId), k, s(k?.keywordText), s(k?.matchType), cents(k?.bid));
  }
  for (const t of roh.targets) {
    zeile("target", s(t?.targetId), t, targetText(t?.expression), s(t?.expressionType), cents(t?.bid));
  }
  for (const k of roh.negativeKeywords) {
    zeile("negativ_keyword", s(k?.keywordId), k, s(k?.keywordText), s(k?.matchType), null);
  }
  for (const t of roh.negativeTargets) {
    zeile("negativ_target", s(t?.targetId), t, targetText(t?.expression), s(t?.expressionType), null);
  }
  for (const k of roh.kampagnenNegativeKeywords) {
    zeile("kampagne_negativ_keyword", s(k?.keywordId), k, s(k?.keywordText), s(k?.matchType), null);
  }
  for (const t of roh.kampagnenNegativeTargets) {
    zeile("kampagne_negativ_target", s(t?.targetId), t, targetText(t?.expression), s(t?.expressionType), null);
  }
  return out;
}

// --- Leser ---

export interface ZielZeile {
  art: ZielArt;
  ziel_id: string;
  campaign_id: string;
  ad_group_id: string;
  text: string | null;
  match_type: string | null;
  state: string | null;
  gebot_cents: number | string | null;
}

function euro(c: number | string | null | undefined): number | null {
  if (c === null || c === undefined) return null;
  const n = Number(c);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

/**
 * Effektives Gebot: eigenes, sonst das Standardgebot der Anzeigengruppe. Beide
 * unbekannt → null. `geerbt` sagt, welcher Fall vorliegt — das Bulk-Sheet zeigt
 * dort eine leere Zelle, und genau die übersieht man beim Optimieren gern.
 */
export function effektivesGebot(
  gebotCents: number | string | null | undefined,
  standardCents: number | string | null | undefined,
): { gebot: number | null; geerbt: boolean } {
  const eigen = euro(gebotCents);
  if (eigen !== null) return { gebot: eigen, geerbt: false };
  const std = euro(standardCents);
  return { gebot: std, geerbt: std !== null };
}

export const NEGATIV_ARTEN: ZielArt[] = [
  "negativ_keyword",
  "negativ_target",
  "kampagne_negativ_keyword",
  "kampagne_negativ_target",
];

/**
 * Aktueller Stand des Werbekontos. Ohne campaign_id: Kampagnenliste mit
 * Budget, Modifiern und Zählern. Mit campaign_id: dazu alle Ziele und
 * Negatives dieser Kampagne — Tausende Keywords auf einmal will niemand
 * über MCP lesen.
 */
export async function adsStruktur(
  supabase: any,
  tenant_id: string,
  opts?: { campaign_id?: unknown; nur_aktive?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  // Ohne diesen Filter wuerden die Direktabfragen unten Kampagnen aus allen
  // Profilen in eine Liste werfen — Kampagnen-IDs sind je Profil vergeben.
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);

  const { data: standRow, error: standErr } = await supabase
    .from("ads_kampagnen")
    .select("gesehen_am")
    .eq("tenant_id", tenant_id)
    .eq("marktplatz", kopf.marktplatz)
    .order("gesehen_am", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (standErr) throw new Error(`ads_kampagnen: ${standErr.message}`);
  if (!standRow) {
    return {
      stand: null,
      kampagnen: [],
      hinweise: ["Noch kein Struktur-Snapshot vorhanden — der Lauf sync-ads-struktur ist für diesen Mandanten noch nicht durchgelaufen."],
    };
  }
  const stand: string = standRow.gesehen_am;
  const nurAktive = opts?.nur_aktive !== false;
  const campaignId = typeof opts?.campaign_id === "string" && opts.campaign_id.trim() ? opts.campaign_id.trim() : null;

  let kq = supabase.from("ads_kampagnen").select("*").eq("tenant_id", tenant_id)
    .eq("marktplatz", kopf.marktplatz).eq("gesehen_am", stand);
  if (campaignId) kq = kq.eq("campaign_id", campaignId);
  else if (nurAktive) kq = kq.neq("state", "ARCHIVED");
  const { data: kampagnen, error: kErr } = await kq.order("name");
  if (kErr) throw new Error(`ads_kampagnen: ${kErr.message}`);

  const ids = (kampagnen ?? []).map((k: any) => k.campaign_id);
  if (ids.length === 0) return { stand, kampagnen: [], hinweise: campaignId ? [`Kampagne ${campaignId} nicht im aktuellen Stand.`] : ["Keine Kampagnen im aktuellen Stand."] };

  const { data: gruppen, error: gErr } = await supabase
    .from("ads_anzeigengruppen").select("*")
    .eq("tenant_id", tenant_id).eq("marktplatz", kopf.marktplatz)
    .eq("gesehen_am", stand).in("campaign_id", ids);
  if (gErr) throw new Error(`ads_anzeigengruppen: ${gErr.message}`);

  // Zähler je Kampagne aus SQL, damit die Übersicht nicht alle Ziele lädt.
  const { data: zaehler, error: zErr } = await supabase.rpc("ads_ziele_zaehler", {
    p_tenant: tenant_id, p_stand: stand, p_marktplatz: kopf.marktplatz,
  });
  if (zErr) throw new Error(`ads_ziele_zaehler: ${zErr.message}`);
  const zProKampagne = new Map<string, Record<string, number>>();
  for (const z of zaehler ?? []) {
    const m = zProKampagne.get(z.campaign_id) ?? {};
    m[z.art] = Number(z.anzahl);
    zProKampagne.set(z.campaign_id, m);
  }

  const stdProGruppe = new Map<string, number | string | null>();
  for (const g of gruppen ?? []) stdProGruppe.set(g.ad_group_id, g.standard_gebot_cents);

  let ziele: ZielZeile[] = [];
  if (campaignId) {
    const { data, error } = await supabase
      .from("ads_ziele").select("art, ziel_id, campaign_id, ad_group_id, text, match_type, state, gebot_cents")
      .eq("tenant_id", tenant_id).eq("marktplatz", kopf.marktplatz)
      .eq("gesehen_am", stand).eq("campaign_id", campaignId)
      .order("art").order("text");
    if (error) throw new Error(`ads_ziele: ${error.message}`);
    ziele = (data ?? []) as ZielZeile[];
  }

  const ausgabe = (kampagnen ?? []).map((k: any) => {
    const z = zProKampagne.get(k.campaign_id) ?? {};
    const eigene = ziele.filter((x) => x.campaign_id === k.campaign_id);
    return {
      campaignId: k.campaign_id,
      name: k.name,
      state: k.state,
      targetingTyp: k.targeting_typ,
      budget: euro(k.budget_cents),
      budgetTyp: k.budget_typ,
      gebotsStrategie: k.gebots_strategie,
      platzierung: {
        top_prozent: k.mod_top_prozent,
        produktseite_prozent: k.mod_produktseite_prozent,
        rest_prozent: k.mod_rest_prozent,
      },
      anzahl: {
        keywords: z.keyword ?? 0,
        targets: z.target ?? 0,
        negatives: NEGATIV_ARTEN.reduce((sum, a) => sum + (z[a] ?? 0), 0),
      },
      anzeigengruppen: (gruppen ?? [])
        .filter((g: any) => g.campaign_id === k.campaign_id)
        .map((g: any) => ({ adGroupId: g.ad_group_id, name: g.name, state: g.state, standardGebot: euro(g.standard_gebot_cents) })),
      ...(campaignId
        ? {
          ziele: eigene.filter((x) => !NEGATIV_ARTEN.includes(x.art)).map((x) => ({
            art: x.art, id: x.ziel_id, adGroupId: x.ad_group_id, text: x.text, matchType: x.match_type, state: x.state,
            ...effektivesGebot(x.gebot_cents, stdProGruppe.get(x.ad_group_id)),
          })),
          negatives: eigene.filter((x) => NEGATIV_ARTEN.includes(x.art)).map((x) => ({
            art: x.art, id: x.ziel_id, adGroupId: x.ad_group_id || null, text: x.text, matchType: x.match_type, state: x.state,
            ebene: x.art.startsWith("kampagne_") ? "kampagne" : "anzeigengruppe",
          })),
        }
        : {}),
    };
  });

  return {
    ...kopf,
    stand,
    waehrungshinweis: "Beträge in der Währung des Werbeprofils.",
    kampagnen: ausgabe,
    hinweise: [
      "Snapshot vom letzten Struktur-Lauf — Gebote und Budgets können seither in der Konsole geändert worden sein.",
      ...(campaignId ? [] : ["Ziele und Negatives einer Kampagne: dasselbe Werkzeug mit campaign_id aufrufen."]),
    ],
  };
}

// --- Struktur-Historie -------------------------------------------------------
//
// Der Snapshot überschreibt den alten Stand. Ein Datenbank-Trigger hält vorher
// fest, was sich an Budget, Zustand, Gebotsstrategie, Platzierungs-Modifiern
// und Geboten geändert hat (Tabelle ads_struktur_aenderungen), und ads_ziele
// merkt sich, wann ein Ziel zum ersten Mal auftauchte (erstmals_gesehen).

/** Geldfelder liegen in Cent — nach außen in Euro, alles andere unverändert. */
export function lesbarerWert(feld: string, wert: string | null): string | number | null {
  if (wert === null || wert === undefined) return null;
  return feld.endsWith("_cents") ? euro(wert) : wert;
}

/**
 * Was wurde am Aufbau des Werbekontos geändert, und was kam neu dazu.
 * Default: die letzten 30 Tage. Die Spur beginnt mit dem Tag, an dem der
 * Trigger eingerichtet wurde — davor gibt es nichts, und das steht in den
 * Hinweisen statt als leere Liste dazustehen.
 */
export async function adsStrukturAenderungen(
  supabase: any,
  tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; campaign_id?: unknown; limit?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const tag = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  const von = tag(opts?.von) ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const bis = tag(opts?.bis) ?? new Date().toISOString().slice(0, 10);
  const bisEnde = `${bis}T23:59:59.999Z`;
  const limit = Math.max(1, Math.min(Number(opts?.limit) || 500, 2000));
  const campaignId = typeof opts?.campaign_id === "string" && opts.campaign_id.trim() ? opts.campaign_id.trim() : null;

  let aq = supabase.from("ads_struktur_aenderungen")
    .select("erkannt_am, stand_vorher, ebene, art, objekt_id, campaign_id, bezeichnung, feld, vorher, nachher")
    .eq("tenant_id", tenant_id).eq("marktplatz", kopf.marktplatz)
    .gte("erkannt_am", von).lte("erkannt_am", bisEnde)
    .order("erkannt_am", { ascending: false }).limit(limit);
  if (campaignId) aq = aq.eq("campaign_id", campaignId);
  const { data: aend, error: aErr } = await aq;
  if (aErr) throw new Error(`ads_struktur_aenderungen: ${aErr.message}`);

  let nq = supabase.from("ads_ziele")
    .select("erstmals_gesehen, art, ziel_id, campaign_id, ad_group_id, text, match_type, state, gebot_cents")
    .eq("tenant_id", tenant_id).eq("marktplatz", kopf.marktplatz)
    .gte("erstmals_gesehen", von).lte("erstmals_gesehen", bisEnde)
    .order("erstmals_gesehen", { ascending: false }).limit(limit);
  if (campaignId) nq = nq.eq("campaign_id", campaignId);
  const { data: neu, error: nErr } = await nq;
  if (nErr) throw new Error(`ads_ziele: ${nErr.message}`);

  // Seit wann überhaupt mitgeschrieben wird: ohne das sähe "keine Änderung"
  // genauso aus wie "noch nicht hingesehen".
  const { data: erste } = await supabase.from("ads_ziele")
    .select("erstmals_gesehen").eq("tenant_id", tenant_id).eq("marktplatz", kopf.marktplatz)
    .not("erstmals_gesehen", "is", null).order("erstmals_gesehen").limit(1).maybeSingle();

  return {
    ...kopf,
    zeitraum: { von, bis },
    anzahl_aenderungen: (aend ?? []).length,
    anzahl_neu: (neu ?? []).length,
    aenderungen: (aend ?? []).map((a: any) => ({
      erkannt_am: a.erkannt_am,
      // Die Änderung liegt irgendwo zwischen diesen beiden Snapshots.
      fenster_ab: a.stand_vorher,
      ebene: a.ebene,
      art: a.art,
      id: a.objekt_id,
      campaignId: a.campaign_id,
      bezeichnung: a.bezeichnung,
      feld: a.feld.replace(/_cents$/, ""),
      vorher: lesbarerWert(a.feld, a.vorher),
      nachher: lesbarerWert(a.feld, a.nachher),
    })),
    neu_angelegt: (neu ?? []).map((z: any) => ({
      erstmals_gesehen: z.erstmals_gesehen,
      art: z.art,
      id: z.ziel_id,
      campaignId: z.campaign_id,
      adGroupId: z.ad_group_id || null,
      text: z.text,
      matchType: z.match_type,
      state: z.state,
      gebot: euro(z.gebot_cents),
    })),
    hinweise: [
      "Abgeleitet aus dem täglichen Struktur-Snapshot, nicht aus Amazons Protokoll: "
      + "jede Änderung ist nur auf das Fenster zwischen zwei Snapshots genau "
      + "(`fenster_ab` bis `erkannt_am`), und mehrere Änderungen im selben Fenster "
      + "erscheinen als eine. Wer geändert hat, steht hier nicht.",
      "Entfernte oder archivierte Ziele erscheinen nicht — sie fallen nur aus dem Snapshot.",
      erste?.erstmals_gesehen
        ? `Neue Ziele werden seit ${String(erste.erstmals_gesehen).slice(0, 10)} erkannt. `
          + "Was davor schon da war, hat kein Anlagedatum."
        : "Seit Einrichtung der Spur ist noch kein neues Ziel dazugekommen — oder der "
          + "Struktur-Snapshot ist seither nicht gelaufen.",
    ],
  };
}

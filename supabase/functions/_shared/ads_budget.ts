// ads_budget.ts — wie weit ist das Tagesbudget einer Kampagne ausgeschöpft.
//
// Hector zeigt "Budget-Lockout" aus Amazons Stundendaten (Marketing Stream, nur
// über AWS). Pulse hat die nicht. Amazons Budget-Usage-API sagt aber, wie viel
// Prozent des Tagesbudgets eine Kampagne JETZT verbraucht hat. Stündlich
// gefragt, entsteht daraus eine eigene Zeitreihe.
//
// WANN sie leer lief, sagt Amazon selbst: jede Antwort trägt den Stempel der
// letzten Bewegung (usageUpdatedTimestamp). Steht eine Kampagne bei 100 % und
// der Stempel bei 20:53, lief sie um 20:53 leer — genauer als jede stündliche
// Messung. Die stündliche Messung braucht es trotzdem: nur sie zeigt, dass sich
// danach nichts mehr bewegt hat.
//
// Was hier NICHT steht: entgangener Umsatz. Dafür bräuchte man den Umsatz je
// Stunde; ihn aus Tageswerten zu schätzen wäre geraten. Es steht da, wie viele
// Stunden die Kampagne still war — die Bewertung bleibt beim Leser.
//
// Über 100 % ist möglich: wird das Budget gesenkt, nachdem schon mehr
// ausgegeben war, steht die Auslastung darüber.
//
// Gespeichert werden nur Messungen ab SCHWELLE Prozent. Eine Kampagne bei 12 %
// stündlich zu protokollieren kostet Platz und sagt nichts. Dass überhaupt
// gemessen wurde, steht je Lauf in report_jobs — sonst sähe "keine Zeile" wie
// "nicht ausgeschöpft" aus, obwohl vielleicht nur die Messung fehlte.
//
// ponytail: nur Sponsored Products. Sponsored Brands hat einen eigenen
// Endpunkt (/sb/campaigns/budget/usage); ergänzen, wenn SB-Budgets knapp werden.

import { ladeSteuerung } from "./ads_steuerung.ts";
import { marktplatzKopf } from "./ads_marktplatz.ts";

export const SCHWELLE = 80;
export const AUSGESCHOEPFT = 100;

export interface UsageEintrag {
  campaignId?: string | number;
  budgetUsagePercent?: number | string | null;
  budget?: number | string | null;
  usageUpdatedTimestamp?: string | null;
}

function zahl(x: unknown): number | null {
  const n = Number(x);
  return x === null || x === undefined || x === "" || !Number.isFinite(n) ? null : n;
}

/** Aus Amazons Antwort werden Zeilen für ads_budget_auslastung — nur ab der Schwelle. */
export function baueAuslastungRows(
  tenant_id: string, marktplatz: string, eintraege: UsageEintrag[], gemessen_am: string, schwelle = SCHWELLE,
) {
  const out: Record<string, unknown>[] = [];
  for (const e of eintraege ?? []) {
    const id = e?.campaignId === null || e?.campaignId === undefined ? "" : String(e.campaignId).trim();
    const prozent = zahl(e?.budgetUsagePercent);
    if (!id || prozent === null || prozent < schwelle) continue;
    const budget = zahl(e?.budget);
    out.push({
      tenant_id, marktplatz, campaign_id: id, gemessen_am,
      auslastung_prozent: Math.round(prozent * 100) / 100,
      budget_cents: budget === null ? null : Math.round(budget * 100),
      amazon_stand: e?.usageUpdatedTimestamp ?? null,
    });
  }
  return out;
}

/**
 * Stunden ohne Bewegung: von Amazons letztem Stempel bis zum Tagesende — oder
 * bis jetzt, wenn der Tag noch läuft. Eine Nachkommastelle; null ohne Stempel.
 */
export function stundenStill(letzteBewegung: string | null, tagesende: string, jetzt: Date = new Date()): number | null {
  if (!letzteBewegung) return null;
  const von = Date.parse(letzteBewegung);
  const bis = Math.min(Date.parse(tagesende), jetzt.getTime());
  if (!Number.isFinite(von) || !Number.isFinite(bis)) return null;
  return Math.max(0, Math.round(((bis - von) / 3_600_000) * 10) / 10);
}

export interface TagZeile {
  tag: string; campaign_id: string; campaign_name: string | null;
  hoechste: number | string; n_voll: number; n_ab_schwelle: number;
  voll_seit: string | null; letzte_bewegung: string | null; zuletzt_gemessen: string;
  budget_cents: number | string | null; tagesende: string;
}

export function baueBudgetTag(z: TagZeile, messungenAmTag: number, jetzt: Date = new Date()) {
  const ausgeschoepft = Number(z.n_voll) > 0;
  return {
    tag: z.tag,
    campaignId: z.campaign_id,
    kampagne: z.campaign_name,
    budget: z.budget_cents === null || z.budget_cents === undefined ? null : Number(z.budget_cents) / 100,
    hoechste_auslastung: Number(z.hoechste),
    ausgeschoepft,
    // Amazons Stempel der ersten Messung mit 100 %: da lief sie spätestens leer.
    ausgeschoepft_seit: ausgeschoepft ? z.voll_seit : null,
    // Nur bei ausgeschöpften Kampagnen: wie lange danach nichts mehr lief.
    stunden_ohne_auslieferung: ausgeschoepft ? stundenStill(z.letzte_bewegung, z.tagesende, jetzt) : null,
    // "Ausgeschöpft bei 4 von 24 Messungen" — damit ein Tag mit zwei Messungen
    // nicht aussieht wie ein voll gemessener.
    messungen_ausgeschoepft: Number(z.n_voll),
    messungen_am_tag: messungenAmTag,
    tag_laeuft_noch: Date.parse(z.tagesende) > jetzt.getTime(),
  };
}

function datum(x: unknown): string | null {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
}

export async function adsBudget(
  supabase: any, tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; marktplatz?: unknown; nur_ausgeschoepft?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const von = datum(opts?.von) ?? new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  // Bis morgen: der laufende Tag in deutscher Zeit kann in UTC schon "morgen" sein.
  const bis = datum(opts?.bis) ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const nurVoll = opts?.nur_ausgeschoepft === true || String(opts?.nur_ausgeschoepft) === "true";

  const { data, error } = await supabase.rpc("ads_budget_tage", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_von: von, p_bis: bis,
  });
  if (error) throw new Error("ads_budget_tage: " + error.message);

  const jeTag = (data?.messungen_je_tag ?? {}) as Record<string, number>;
  const jetzt = new Date();
  const modusVon = await ladeSteuerung(supabase, tenant_id);
  const alle = ((data?.zeilen ?? []) as TagZeile[])
    .map((z) => ({ ...baueBudgetTag(z, Number(jeTag[z.tag]) || 0, jetzt), steuerung: modusVon(z.campaign_id) }));
  const tage = nurVoll ? alle.filter((t) => t.ausgeschoepft) : alle;
  const voll = alle.filter((t) => t.ausgeschoepft);

  // Je Kampagne: an wie vielen Tagen leer, und wie lange.
  const jeKampagne = new Map<string, { kampagne: string | null; tage: number; stunden: number }>();
  for (const t of voll) {
    const e = jeKampagne.get(t.campaignId) ?? { kampagne: t.kampagne, tage: 0, stunden: 0 };
    e.tage++;
    e.stunden += t.stunden_ohne_auslieferung ?? 0;
    jeKampagne.set(t.campaignId, e);
  }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  // Dieselbe Bilanz nur für Kampagnen, die gesteuert werden — die übrigen kann man hier nur ansehen.
  const gesteuert = voll.filter((t) => t.steuerung !== "nur_analyse");

  return {
    ...kopf,
    zeitraum: { von, bis },
    erste_messung: data?.erste_messung ?? null,
    messungen_je_tag: jeTag,
    schwelle_prozent: SCHWELLE,
    bilanz: {
      kampagnen_ausgeschoepft: jeKampagne.size,
      kampagnentage_ausgeschoepft: voll.length,
      stunden_ohne_auslieferung: r1(voll.reduce((n, t) => n + (t.stunden_ohne_auslieferung ?? 0), 0)),
      gesteuert: {
        kampagnen_ausgeschoepft: new Set(gesteuert.map((t) => t.campaignId)).size,
        kampagnentage_ausgeschoepft: gesteuert.length,
        stunden_ohne_auslieferung: r1(gesteuert.reduce((n, t) => n + (t.stunden_ohne_auslieferung ?? 0), 0)),
      },
    },
    kampagnen: [...jeKampagne.entries()]
      .map(([campaignId, e]) => ({
        campaignId, kampagne: e.kampagne, steuerung: modusVon(campaignId), tage_ausgeschoepft: e.tage,
        stunden_ohne_auslieferung: r1(e.stunden),
        stunden_je_tag: r1(e.stunden / e.tage),
      }))
      .sort((a, b) => b.stunden_ohne_auslieferung - a.stunden_ohne_auslieferung),
    tage,
    hinweise: [
      "Gemessen wird stündlich, gespeichert ab " + SCHWELLE + " % Auslastung. `ausgeschoepft_seit` ist Amazons "
      + "eigener Stempel der letzten Bewegung — der Zeitpunkt, an dem das Budget leer lief. Zeiten in UTC.",
      "`stunden_ohne_auslieferung`: von da bis zum Tagesende (Mitternacht deutscher Zeit), bei laufendem Tag "
      + "bis jetzt. Entgangener Umsatz steht hier bewusst nicht — er wäre aus Tageswerten nur zu raten.",
      "Über 100 % heißt: das Budget wurde gesenkt, nachdem schon mehr ausgegeben war, oder Amazon hat "
      + "leicht überzogen.",
      data?.erste_messung
        ? "Die Messung läuft seit " + String(data.erste_messung).slice(0, 10) + ". Davor gibt es nichts."
        : "Noch keine Messung gelaufen.",
      "Nur Sponsored Products.",
      "`steuerung` je Zeile: pulse und h10 sind Kampagnen der verwalteten Produkte (bei h10 setzt Helium 10 die "
      + "Gebote, das Budget bleibt bei Pulse), nur_analyse wird nur ausgewertet. `bilanz.gesteuert` zählt ohne diese.",
    ],
  };
}

// ads_budget.ts — wie weit ist das Tagesbudget einer Kampagne ausgeschöpft.
//
// Hector zeigt "Budget-Lockout" aus Amazons Stundendaten (Marketing Stream, nur
// über AWS). Pulse hat die nicht. Amazons Budget-Usage-API sagt aber, wie viel
// Prozent des Tagesbudgets eine Kampagne JETZT verbraucht hat. Stündlich
// gefragt, entsteht daraus eine eigene Zeitreihe: ab welcher Messung stand die
// Kampagne bei 100 %.
//
// Das ist gröber als Hector und sagt es auch:
//   - Die Auflösung ist eine Stunde. "Ab 14 Uhr ausgeschöpft" heißt: bei der
//     Messung um 14 Uhr war sie es, bei der um 13 Uhr noch nicht.
//   - Entgangener Umsatz steht hier NICHT. Dafür bräuchte man den Umsatz je
//     Stunde; ihn aus Tageswerten zu schätzen wäre geraten.
//
// Gespeichert werden nur Messungen ab SCHWELLE Prozent. Eine Kampagne bei 12 %
// stündlich zu protokollieren kostet Platz und sagt nichts. Dass überhaupt
// gemessen wurde, steht je Lauf in report_jobs — sonst sähe "keine Zeile" wie
// "nicht ausgeschöpft" aus, obwohl vielleicht nur die Messung fehlte.
//
// ponytail: nur Sponsored Products. Sponsored Brands hat einen eigenen
// Endpunkt (/sb/campaigns/budget/usage); ergänzen, wenn SB-Budgets knapp werden.

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

export interface Messung { tag: string; gemessen_am: string; auslastung_prozent: number; budget_cents: number | null }

/**
 * Je Kampagne und Tag: wann zum ersten Mal ausgeschöpft, und bei wie vielen
 * der Messungen dieses Tages. `messungen_am_tag` kommt aus dem Laufprotokoll —
 * "ausgeschöpft bei 9 von 24 Messungen" ist die ehrliche Form von "9 Stunden".
 */
export function fasseTagZusammen(messungen: Messung[], messungenAmTag: number) {
  const sortiert = [...messungen].sort((a, b) => a.gemessen_am.localeCompare(b.gemessen_am));
  const voll = sortiert.filter((m) => m.auslastung_prozent >= AUSGESCHOEPFT);
  const letzte = sortiert[sortiert.length - 1];
  return {
    hoechste_auslastung: sortiert.reduce((m, x) => Math.max(m, x.auslastung_prozent), 0),
    ausgeschoepft: voll.length > 0,
    // Erste Messung, bei der das Budget schon weg war. Der wahre Zeitpunkt
    // liegt bis zu eine Stunde davor.
    ausgeschoepft_seit: voll[0]?.gemessen_am ?? null,
    messungen_ausgeschoepft: voll.length,
    messungen_am_tag: messungenAmTag,
    budget: letzte?.budget_cents === null || letzte?.budget_cents === undefined ? null : letzte.budget_cents / 100,
  };
}

// gebote.ts — Gebotsänderungen für Sponsored Products rechnen (reines Modul).
//
// Kein Netz, keine DB. Der Netz-/Auth-Teil liegt in der Function ads-gebote;
// hier nur, was unit-testbar ist: aus aktuellen Geboten + Regel die neuen Gebote
// ableiten, mit Untergrenze und Kappung.
//
// Amazon-Untergrenze für SP-Gebote im EU-Raum: 0,02 (DE/FR/IT/ES in EUR, UK in GBP).
// Amazon lehnt kleinere Werte mit 422 ab — deshalb hier schon abfangen.

export const MIN_GEBOT = 0.02;

/** Eine Regel, wie Gebote verändert werden sollen. Genau EINES von prozent /
 *  faktor / absolut ist gesetzt. `min`/`max` klemmen das Ergebnis ein. */
export interface GebotsRegel {
  /** relative Änderung in Prozent, z. B. -20 (senken) oder +10 (erhöhen) */
  prozent?: number;
  /** Multiplikator, z. B. 0.8 */
  faktor?: number;
  /** festes Zielgebot für alle Treffer */
  absolut?: number;
  /** nicht unter diesen Wert (Standard MIN_GEBOT) */
  min?: number;
  /** nicht über diesen Wert */
  max?: number;
}

export interface GebotsZeile {
  art: "keyword" | "target";
  id: string;            // keywordId bzw. targetId
  campaignId: string;
  adGroupId: string;
  text: string;          // Keyword-Text bzw. Ausdruck des Targets
  matchType?: string;
  state?: string;
  gebot: number;         // aktuelles Gebot
}

export interface Aenderung extends GebotsZeile {
  neu: number;
  delta: number;         // neu - gebot
}

/** Prüft die Regel auf Plausibilität. Gibt einen Fehlertext oder null zurück. */
export function pruefeRegel(r: GebotsRegel): string | null {
  const gesetzt = [r.prozent, r.faktor, r.absolut].filter((x) => x !== undefined && x !== null);
  if (gesetzt.length !== 1) return "Genau eine Angabe von prozent, faktor oder absolut.";
  if (r.prozent !== undefined && (!Number.isFinite(r.prozent) || r.prozent <= -100)) return "prozent muss > -100 sein.";
  if (r.faktor !== undefined && (!Number.isFinite(r.faktor) || r.faktor <= 0)) return "faktor muss > 0 sein.";
  if (r.absolut !== undefined && (!Number.isFinite(r.absolut) || r.absolut < MIN_GEBOT)) return `absolut muss >= ${MIN_GEBOT} sein.`;
  if (r.min !== undefined && (!Number.isFinite(r.min) || r.min < MIN_GEBOT)) return `min muss >= ${MIN_GEBOT} sein.`;
  if (r.max !== undefined && (!Number.isFinite(r.max) || r.max < MIN_GEBOT)) return `max muss >= ${MIN_GEBOT} sein.`;
  if (r.min !== undefined && r.max !== undefined && r.min > r.max) return "min darf nicht über max liegen.";
  return null;
}

/** Neues Gebot für EIN aktuelles Gebot. Auf 2 Nachkommastellen, nie unter MIN_GEBOT. */
export function neuesGebot(aktuell: number, r: GebotsRegel): number {
  let n: number;
  if (r.absolut !== undefined) n = r.absolut;
  else if (r.faktor !== undefined) n = aktuell * r.faktor;
  else n = aktuell * (1 + (r.prozent ?? 0) / 100);
  const untergrenze = Math.max(MIN_GEBOT, r.min ?? MIN_GEBOT);
  if (n < untergrenze) n = untergrenze;
  if (r.max !== undefined && n > r.max) n = r.max;
  return Math.round(n * 100) / 100;
}

/** Wendet die Regel auf alle Zeilen an. Zeilen, deren Gebot sich nicht ändert,
 *  fallen weg — die will man weder sehen noch an Amazon schicken. */
export function baueAenderungen(zeilen: GebotsZeile[], r: GebotsRegel): Aenderung[] {
  const out: Aenderung[] = [];
  for (const z of zeilen) {
    if (!Number.isFinite(z.gebot)) continue;
    const neu = neuesGebot(z.gebot, r);
    if (neu === Math.round(z.gebot * 100) / 100) continue;
    out.push({ ...z, neu, delta: Math.round((neu - z.gebot) * 100) / 100 });
  }
  return out;
}

/** Kurze Zusammenfassung für die Vorschau. */
export function fasseZusammen(aend: Aenderung[]): { anzahl: number; keywords: number; targets: number; summe_alt: number; summe_neu: number } {
  let keywords = 0, targets = 0, alt = 0, neu = 0;
  for (const a of aend) {
    if (a.art === "keyword") keywords++; else targets++;
    alt += a.gebot; neu += a.neu;
  }
  return { anzahl: aend.length, keywords, targets, summe_alt: Math.round(alt * 100) / 100, summe_neu: Math.round(neu * 100) / 100 };
}

/** Ausdruck eines Product-Targets lesbar machen, z. B. "asinSameAs=B0XYZ" oder "close-match". */
export function targetText(expression: unknown): string {
  if (!Array.isArray(expression)) return "";
  return expression.map((e: any) => (e?.value ? `${e.type}=${e.value}` : String(e?.type ?? ""))).join(" & ");
}

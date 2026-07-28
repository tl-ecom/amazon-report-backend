// ratelimit.ts — Wartezeiten aus den Antwort-Headern der SP-API ableiten.
//
// Reines Modul: nimmt Header, gibt Millisekunden zurück. Kein Netz, keine DB.
//
// ACHTUNG, häufigste Fehlerquelle: `x-amzn-RateLimit-Limit` ist eine RATE in
// Requests pro Sekunde, KEINE Wartezeit. Amazon schickt z.B. "0.0167" — das
// bedeutet "ein Request pro 60 Sekunden" (1 / 0.0167 ≈ 59,9 s). Wer den Wert
// als Sekunden liest, wartet 17 Millisekunden und läuft sofort ins nächste 429.
//
// Die Limits sind pro Operation verschieden und können laut Amazon je Verkäufer
// abweichen — deshalb den Header lesen statt Werte fest zu verdrahten. Die
// Defaults unten sind nur der Notnagel, wenn kein Header mitkommt (bei 429
// liefert Amazon ihn nicht zuverlässig).

/** Dokumentierte Standard-Raten (rps) als Fallback, falls kein Header kommt. */
export const STANDARD_RATEN = {
  createReport: 0.0167, // ~1 pro 60 s
  getReport: 2.0, // Polling darf schnell sein
  getReportDocument: 0.0167, // ~1 pro 60 s
} as const;

/** Nie länger warten als das — sonst ist das Zeitbudget ohnehin futsch. */
export const MAX_WARTE_MS = 60_000;
/** Unter dieser Grenze lohnt sich Warten nicht. */
export const MIN_WARTE_MS = 1_000;

/**
 * Liest `x-amzn-RateLimit-Limit` als Rate (Requests/Sekunde).
 * null, wenn der Header fehlt oder unbrauchbar ist.
 */
export function parseRateLimit(headers: Headers): number | null {
  const roh = headers.get("x-amzn-RateLimit-Limit");
  if (!roh) return null;
  const rate = Number(roh.trim());
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

/**
 * Liest `Retry-After`. Erlaubt sind laut HTTP zwei Formate:
 * Sekunden ("120") oder ein HTTP-Datum ("Wed, 21 Oct 2026 07:28:00 GMT").
 * Gibt Millisekunden zurück, null wenn nicht vorhanden/lesbar.
 */
export function parseRetryAfter(headers: Headers, jetzt: number = Date.now()): number | null {
  const roh = headers.get("Retry-After");
  if (!roh) return null;

  const sekunden = Number(roh.trim());
  if (Number.isFinite(sekunden)) {
    if (sekunden < 0) return null;
    return Math.round(sekunden * 1000);
  }

  const datum = Date.parse(roh);
  if (Number.isNaN(datum)) return null;
  const diff = datum - jetzt;
  return diff > 0 ? diff : 0;
}

/** Rate (rps) → Abstand zwischen zwei Requests in ms. */
export function rateZuWartezeitMs(rate: number): number {
  return Math.ceil(1000 / rate);
}

/**
 * Wartezeit nach einem 429 bestimmen. Reihenfolge der Autorität:
 *   1. Retry-After  — Amazon sagt explizit, wie lange
 *   2. x-amzn-RateLimit-Limit — daraus den Abstand rechnen
 *   3. fallbackRate — dokumentierter Standard für die Operation
 * Ergebnis wird auf [MIN_WARTE_MS, MAX_WARTE_MS] begrenzt.
 */
export function wartezeitNach429(
  headers: Headers,
  fallbackRate: number,
  jetzt: number = Date.now()
): number {
  const retryAfter = parseRetryAfter(headers, jetzt);
  if (retryAfter !== null) return begrenze(retryAfter);

  const rate = parseRateLimit(headers) ?? fallbackRate;
  return begrenze(rateZuWartezeitMs(rate));
}

function begrenze(ms: number): number {
  return Math.min(Math.max(ms, MIN_WARTE_MS), MAX_WARTE_MS);
}

/**
 * Beobachtete Rate für Diagnose-Zwecke. Amazon schickt den Header auch bei
 * erfolgreichen Antworten — so sieht man, welche Limits für DIESEN Verkäufer
 * gelten, statt sich auf die Doku zu verlassen.
 */
export function beobachteteRate(headers: Headers): number | null {
  return parseRateLimit(headers);
}

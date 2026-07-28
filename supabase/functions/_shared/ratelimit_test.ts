// Tests für ratelimit.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import {
  MAX_WARTE_MS,
  MIN_WARTE_MS,
  parseRateLimit,
  parseRetryAfter,
  rateZuWartezeitMs,
  STANDARD_RATEN,
  wartezeitNach429,
} from "./ratelimit.ts";

const h = (obj: Record<string, string>) => new Headers(obj);

// --- Der Kern: Rate ist keine Wartezeit ---
Deno.test("x-amzn-RateLimit-Limit wird als Rate gelesen, nicht als Sekunden", () => {
  const headers = h({ "x-amzn-RateLimit-Limit": "0.0167" });

  assertEquals(parseRateLimit(headers), 0.0167);

  // 0.0167 rps → ein Request pro ~60 s.
  const warte = wartezeitNach429(headers, STANDARD_RATEN.createReport);
  assertEquals(warte, 59881);

  // Der klassische Fehler wäre, 0.0167 als Sekunden zu lesen → 17 ms.
  assertEquals(warte > 1000, true);
});

Deno.test("hohe Rate ergibt kurze Wartezeit", () => {
  // getReport darf 2/s → 500 ms Abstand, aber die Untergrenze greift.
  const warte = wartezeitNach429(h({ "x-amzn-RateLimit-Limit": "2.0" }), STANDARD_RATEN.getReport);
  assertEquals(warte, MIN_WARTE_MS);
});

Deno.test("rateZuWartezeitMs rechnet korrekt um", () => {
  assertEquals(rateZuWartezeitMs(1), 1000);
  assertEquals(rateZuWartezeitMs(2), 500);
  assertEquals(rateZuWartezeitMs(0.5), 2000);
  assertEquals(rateZuWartezeitMs(0.0167), 59881);
});

// --- Retry-After hat Vorrang ---
Deno.test("Retry-After in Sekunden schlaegt den Rate-Header", () => {
  const headers = h({ "Retry-After": "30", "x-amzn-RateLimit-Limit": "0.0167" });
  assertEquals(parseRetryAfter(headers), 30_000);
  // 30 s laut Retry-After, nicht 60 s aus der Rate.
  assertEquals(wartezeitNach429(headers, STANDARD_RATEN.createReport), 30_000);
});

Deno.test("Retry-After als HTTP-Datum wird verstanden", () => {
  const jetzt = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  const headers = h({ "Retry-After": "Wed, 21 Oct 2026 07:28:45 GMT" });
  assertEquals(parseRetryAfter(headers, jetzt), 45_000);
});

Deno.test("Retry-After in der Vergangenheit ergibt 0, nicht negativ", () => {
  const jetzt = Date.parse("Wed, 21 Oct 2026 07:30:00 GMT");
  const headers = h({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" });
  assertEquals(parseRetryAfter(headers, jetzt), 0);
  // Gewartet wird trotzdem die Mindestzeit, nicht gar nicht.
  assertEquals(wartezeitNach429(headers, STANDARD_RATEN.getReport, jetzt), MIN_WARTE_MS);
});

Deno.test("negative Retry-After-Sekunden werden ignoriert", () => {
  assertEquals(parseRetryAfter(h({ "Retry-After": "-5" })), null);
});

// --- Fehlende / kaputte Header ---
Deno.test("ohne Header greift der dokumentierte Fallback", () => {
  // Bei 429 liefert Amazon den Rate-Header nicht zuverlässig.
  const warte = wartezeitNach429(h({}), STANDARD_RATEN.createReport);
  assertEquals(warte, 59881); // Fallback 0.0167 rps
});

Deno.test("unbrauchbare Header-Werte werden ignoriert", () => {
  assertEquals(parseRateLimit(h({ "x-amzn-RateLimit-Limit": "keine-zahl" })), null);
  assertEquals(parseRateLimit(h({ "x-amzn-RateLimit-Limit": "0" })), null);
  assertEquals(parseRateLimit(h({ "x-amzn-RateLimit-Limit": "-1" })), null);
  assertEquals(parseRateLimit(h({})), null);
  assertEquals(parseRetryAfter(h({ "Retry-After": "voelliger-unsinn" })), null);
});

Deno.test("Rate 0 fuehrt nicht zu Division durch Null", () => {
  // parseRateLimit lehnt 0 ab → Fallback greift, kein Infinity.
  const warte = wartezeitNach429(h({ "x-amzn-RateLimit-Limit": "0" }), STANDARD_RATEN.getReport);
  assertEquals(Number.isFinite(warte), true);
  assertEquals(warte, MIN_WARTE_MS); // Fallback 2.0 rps → 500 ms → Untergrenze
});

// --- Grenzen ---
Deno.test("Wartezeit wird nach oben gedeckelt", () => {
  // Absurd kleine Rate → theoretisch ~2,8 Stunden Wartezeit.
  const warte = wartezeitNach429(h({ "x-amzn-RateLimit-Limit": "0.0001" }), STANDARD_RATEN.createReport);
  assertEquals(warte, MAX_WARTE_MS);
});

Deno.test("Wartezeit wird nach unten gedeckelt", () => {
  const warte = wartezeitNach429(h({ "Retry-After": "0" }), STANDARD_RATEN.getReport);
  assertEquals(warte, MIN_WARTE_MS);
});

Deno.test("sehr langes Retry-After wird ebenfalls gedeckelt", () => {
  assertEquals(wartezeitNach429(h({ "Retry-After": "3600" }), STANDARD_RATEN.getReport), MAX_WARTE_MS);
});

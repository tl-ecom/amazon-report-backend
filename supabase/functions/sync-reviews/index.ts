// sync-reviews — Rezensionsthemen je ASIN aus der Customer-Feedback-API.
//
// Zwei Aufrufe je ASIN: getItemReviewTopics (Themen mit Nennungen, Sterne-
// Einfluss und Vergleich zur Kategorie) und getItemReviewTrends (Monatsverlauf).
//
// WOECHENTLICH, nicht taeglich: Amazon frischt diese Daten einmal die Woche auf.
// Ein taeglicher Abruf verbrennt Rate-Limit fuer Zahlen, die sich nicht bewegt
// haben — und erzeugt einen "Trend", der nur Rauschen ist.
//
// NUR CHILD-ASINs: die Item-Endpunkte lehnen Parent-ASINs ab. Bei Vaneja sind
// 29 von 39 ASINs Kinder; ohne Filter stuende die Haelfte der Laeufe auf Fehler.
//
// Aufruf mit Service-Role, Body {tenant_id, asin?, marktplatz?, limit?}.
// Ohne `asin` werden die ASINs mit Umsatz genommen.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseThemen, parseTrend } from "../_shared/reviews.ts";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";
const BASIS = "/customerFeedback/2024-06-01";

/** Zeitbudget. Zwei Aufrufe je ASIN, Amazon drosselt — lieber weniger ASINs. */
const DEADLINE_MS = 220000;
const PAUSE_MS = 1200;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const schlaf = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readSecret(supabase: any, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.rpc("read_vault_secret", { p_secret_id: id });
  return (data as string) ?? null;
}

async function holeAccessToken(cid: string, cs: string, rt: string): Promise<string | null> {
  const resp = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: rt, client_id: cid, client_secret: cs,
    }),
  });
  const d = await resp.json().catch(() => ({}));
  return resp.ok ? ((d as any).access_token ?? null) : null;
}

/** Ein GET gegen die Customer-Feedback-API, mit einem Wiederholungsversuch bei 429. */
async function hole(
  pfad: string, token: string, deadline: number,
): Promise<{ ok: boolean; daten?: any; status: number; detail?: unknown }> {
  for (let versuch = 0; versuch < 2; versuch++) {
    const resp = await fetch(`${SP_ENDPOINT}${pfad}`, {
      headers: { "x-amz-access-token": token, "Accept": "application/json" },
    });
    if (resp.status === 429 && versuch === 0 && Date.now() + 3000 < deadline) {
      await schlaf(3000);
      continue;
    }
    const daten = await resp.json().catch(() => ({}));
    return { ok: resp.ok, daten, status: resp.status, detail: resp.ok ? undefined : daten };
  }
  return { ok: false, status: 429, detail: "429 auch nach Wiederholung" };
}

Deno.serve(async (req) => {
  const start = Date.now();
  const deadline = start + DEADLINE_MS;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id = String(body?.tenant_id ?? "").trim();
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);
    const limit = Math.max(1, Math.min(Number(body?.limit) || 10, 50));

    const { data: ctx } = await supabase.from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, marketplace_id")
      .eq("tenant_id", tenant_id).eq("source", "sp").maybeSingle();
    if (!ctx) return json({ error: "Kein sp-auth_context für diesen Tenant" }, 404);

    const marktplatz = String(body?.marktplatz ?? "").trim() || String(ctx.marketplace_id);

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) {
      return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    }
    const token = await holeAccessToken(clientId, clientSecret, refreshToken);
    if (!token) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    // Welche ASINs? Entweder die genannte oder die mit dem meisten Umsatz.
    let asins: string[];
    const einzeln = String(body?.asin ?? "").trim().toUpperCase();
    if (einzeln) {
      asins = [einzeln];
    } else {
      const { data } = await supabase.from("orders_history")
        .select("asin, quantity").eq("tenant_id", tenant_id).not("asin", "is", null);
      const proAsin = new Map<string, number>();
      for (const o of data ?? []) {
        proAsin.set(String(o.asin), (proAsin.get(String(o.asin)) ?? 0) + (Number(o.quantity) || 0));
      }
      asins = [...proAsin.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([a]) => a);
    }
    if (asins.length === 0) return json({ ok: true, hinweis: "Keine ASINs mit Umsatz", ergebnisse: [] });

    // Der Stand ist ein DATUM: zwei Abrufe am selben Tag sind derselbe Stand
    // und sollen sich ueberschreiben, nicht verdoppeln.
    const stand = new Date().toISOString().slice(0, 10);
    const ergebnisse: unknown[] = [];

    for (const asin of asins) {
      if (Date.now() > deadline) {
        ergebnisse.push({ asin, status: "uebersprungen", grund: "Zeitbudget aufgebraucht" });
        continue;
      }

      const merke = async (status: string, felder: Record<string, unknown> = {}) => {
        await supabase.from("reviews_laeufe").upsert({
          tenant_id, marktplatz, asin, stand, status,
          beendet: status === "laeuft" ? null : new Date().toISOString(),
          ...felder,
        }, { onConflict: "tenant_id,marktplatz,asin,stand" });
      };
      await merke("laeuft");

      const q = `?marketplaceId=${encodeURIComponent(marktplatz)}`;
      const themenRes = await hole(
        `${BASIS}/items/${encodeURIComponent(asin)}/reviews/topics${q}&sortBy=MENTIONS`,
        token, deadline,
      );

      if (!themenRes.ok) {
        // 403 heisst hier fast immer: Rolle fehlt oder die ASIN ist nicht
        // markenregistriert. 400 meist: Parent-ASIN statt Kind.
        const meldung = themenRes.status === 403
          ? "Amazon verweigert den Zugriff (403). Entweder fehlt der App die Rolle "
            + "Brand Analytics bzw. Selling Partner Insights, oder für diese ASIN "
            + "gibt es keine Markenregistrierung."
          : themenRes.status === 400
          ? "Amazon lehnt die Anfrage ab (400). Häufigster Grund: Es ist eine "
            + "Parent-ASIN — die Item-Endpunkte nehmen nur Child-ASINs."
          : `Amazon antwortete mit HTTP ${themenRes.status}.`;
        await merke("fehler", { meldung: meldung.slice(0, 500) });
        ergebnisse.push({ asin, status: "fehler", http: themenRes.status, meldung, detail: themenRes.detail });
        await schlaf(PAUSE_MS);
        continue;
      }

      const themen = parseThemen(themenRes.daten);
      const jetzt = new Date().toISOString();

      if (themen.length > 0) {
        // Nur DIESEN Stand ersetzen — aeltere Staende bleiben stehen, sonst
        // gibt es nie einen Vorher-Vergleich.
        await supabase.from("reviews_themen").delete()
          .eq("tenant_id", tenant_id).eq("marktplatz", marktplatz)
          .eq("asin", asin).eq("stand", stand);
        await supabase.from("reviews_themen").insert(
          themen.map((t) => ({ tenant_id, marktplatz, asin, stand, updated_at: jetzt, ...t })),
        );
      }

      // --- Trend ---
      let trendZahl = 0;
      if (Date.now() < deadline) {
        await schlaf(PAUSE_MS);
        const trendRes = await hole(
          `${BASIS}/items/${encodeURIComponent(asin)}/reviews/trends${q}`, token, deadline,
        );
        if (trendRes.ok) {
          const trend = parseTrend(trendRes.daten);
          trendZahl = trend.length;
          if (trend.length > 0) {
            await supabase.from("reviews_trend").upsert(
              trend.map((t) => ({ tenant_id, marktplatz, asin, updated_at: jetzt, ...t })),
              { onConflict: "tenant_id,marktplatz,asin,richtung,thema,monat" },
            );
          }
        }
      }

      await merke(themen.length > 0 ? "fertig" : "leer", {
        themen: themen.length, trendpunkte: trendZahl,
        meldung: themen.length > 0 ? null
          : "Amazon hat geantwortet, nennt für diese ASIN aber keine Themen.",
      });
      ergebnisse.push({ asin, status: themen.length > 0 ? "fertig" : "leer", themen: themen.length, trendpunkte: trendZahl });
      await schlaf(PAUSE_MS);
    }

    return json({ ok: true, tenant_id, marktplatz, stand, ergebnisse });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

// sync-ads-report — Amazon Advertising API v3 async Reporting in EINEM Aufruf.
//
// Analog zu sync-report (Zeitbudget + Wiederaufnahme), aber gegen die Ads-API:
//   1. Ads-Auth: refresh_token → access_token (LWA), dann Profil-Header.
//   2. POST /reporting/reports  (v3 async) → reportId
//   3. Poll GET /reporting/reports/{id} bis COMPLETED (url) — bis Zeitbudget.
//   4. Download (GZIP_JSON) → Array von Zeilen → speichern (source='ads').
//
// UNTERSCHIED zu SP: eigene Credentials (Advertising-App), Profil-Scope, andere
// Endpoints und Status-Werte. Deshalb eigene Function statt sync-report zu erweitern.
//
// TESTGRENZE (ehrlich): End-to-End braucht einen auth_context mit source='ads'
// (Ads-client_id/secret/refresh_token + profile_id im Vault). Der Test-Tenant hat
// den nicht — ohne ihn gibt die Function einen sauberen 404 "kein ads-auth_context".
// Die Rechen-/Parselogik ist in _shared/ads.ts voll unit-getestet.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { baueSpReportRequest, istVorlaeufig, VOLATIL_TAGE, ymd } from "../_shared/ads.ts";

const ADS_ENDPOINT = "https://advertising-api-eu.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const V3_CONTENT_TYPE = "application/vnd.createasyncreportrequest.v3+json";
const REPORT_TYPE = "sp-advertised-product"; // interner report_type-Schlüssel

const DEFAULT_DAYS = 14;
const POLL_BUDGET_MS = 90_000;
const POLL_START_MS = 5_000;
const POLL_FACTOR = 1.5;
const POLL_MAX_MS = 20_000;
const RATE_LIMIT_WAIT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_BUDGET_MS;

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id: string | undefined = body.tenant_id;
    const resumeReportId: string | undefined = body.report_id;
    const days: number = Number(body.days ?? DEFAULT_DAYS);
    const includeVolatile: boolean = body.include_volatile === true;

    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);
    if (!resumeReportId && (!Number.isFinite(days) || days < 1 || days > 90)) {
      return json({ error: "days muss zwischen 1 und 90 liegen" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Ads-Credentials: auth_context mit source='ads'. service_role umgeht RLS →
    // tenant_id explizit filtern.
    const { data: ctx, error: ctxErr } = await supabase
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, profile_id")
      .eq("tenant_id", tenant_id)
      .eq("source", "ads")
      .maybeSingle();
    if (ctxErr) return json({ error: "auth_context-Lookup fehlgeschlagen", detail: ctxErr.message }, 500);
    if (!ctx) {
      return json({
        error: "Kein ads-auth_context für diesen Tenant",
        hinweis: "Advertising-Credentials (client_id/secret/refresh_token) + profile_id " +
          "mit source='ads' anlegen. Siehe UEBERGABE.md, Abschnitt Ads-API.",
      }, 404);
    }
    if (!ctx.profile_id) {
      return json({ error: "profile_id fehlt im ads-auth_context" }, 400);
    }

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) {
      return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    }

    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    const adsHeaders = {
      "Amazon-Advertising-API-ClientId": clientId,
      "Amazon-Advertising-API-Scope": ctx.profile_id,
      "Authorization": `Bearer ${accessToken}`,
    };

    // ---- Stufe 1: anfordern ODER laufenden Report wiederaufnehmen ----
    let reportId: string;
    let endDate: string;

    if (resumeReportId) {
      const { data: job, error: jobErr } = await supabase
        .from("report_jobs")
        .select("amazon_report_id, config")
        .eq("tenant_id", tenant_id)
        .eq("source", "ads")
        .eq("amazon_report_id", resumeReportId)
        .maybeSingle();
      if (jobErr) return json({ error: "Job-Lookup fehlgeschlagen", detail: jobErr.message }, 500);
      if (!job) return json({ error: "report_id gehört nicht zu diesem Tenant" }, 404);
      reportId = resumeReportId;
      endDate = job.config?.endDate ?? ymd(new Date());
    } else {
      // Fenster: Ads-Daten für heute sind unvollständig. Standard endet
      // VOLATIL_TAGE vor heute (stabil). include_volatile geht bis gestern und
      // markiert den Datensatz später als is_provisional.
      const end = new Date();
      end.setUTCDate(end.getUTCDate() - (includeVolatile ? 1 : VOLATIL_TAGE));
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - days);
      endDate = ymd(end);
      const startDate = ymd(start);

      const created = await erstelleReport(adsHeaders, baueSpReportRequest(startDate, endDate), deadline);
      if (!created.ok) return json({ error: "Ads-Report anfordern fehlgeschlagen", detail: created.detail }, 502);
      reportId = created.reportId!;

      const { error: insErr } = await supabase.from("report_jobs").insert({
        tenant_id,
        source: "ads",
        report_type: REPORT_TYPE,
        status: "PROCESSING",
        amazon_report_id: reportId,
        config: { days, startDate, endDate, include_volatile: includeVolatile },
      });
      if (insErr) return json({ error: "Job speichern fehlgeschlagen", detail: insErr.message }, 500);
    }

    // ---- Stufe 2: pollen bis COMPLETED / FAILED / Budget ----
    let delay = POLL_START_MS;
    let url: string | null = null;

    while (true) {
      const status = await pollReport(adsHeaders, reportId, deadline);
      if (!status.ok) {
        await markJobFatal(supabase, tenant_id, reportId, status.detail);
        return json({ error: "Ads-Report-Status Fehler", detail: status.detail }, 502);
      }
      if (status.status === "COMPLETED") {
        url = status.url ?? null;
        break;
      }
      if (status.status === "FAILED" || status.status === "CANCELLED") {
        await markJobFatal(supabase, tenant_id, reportId, `Ads meldet ${status.status}`);
        return json({ ok: false, status: status.status, report_id: reportId }, 200);
      }
      if (Date.now() + delay >= deadline) {
        return json({
          ok: true,
          status: "PROCESSING",
          report_id: reportId,
          hinweis: "Ads-Report noch nicht fertig. Zeitbudget aufgebraucht (kein Fehler). " +
            "Denselben Aufruf mit report_id wiederholen.",
        }, 200);
      }
      await sleep(delay);
      delay = Math.min(Math.round(delay * POLL_FACTOR), POLL_MAX_MS);
    }

    if (!url) {
      await markJobFatal(supabase, tenant_id, reportId, "COMPLETED, aber keine url");
      return json({ error: "Report fertig, aber keine Download-URL" }, 502);
    }

    // ---- Stufe 3: Download (GZIP_JSON) ----
    const fileResp = await fetch(url);
    if (!fileResp.ok) {
      await markJobFatal(supabase, tenant_id, reportId, `Download HTTP ${fileResp.status}`);
      return json({ error: "Ads-Report-Download fehlgeschlagen", status: fileResp.status }, 502);
    }
    const buf = new Uint8Array(await fileResp.arrayBuffer());
    let rows: Record<string, any>[];
    try {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      await markJobFatal(supabase, tenant_id, reportId, `Entpacken/Parsen: ${String(e)}`);
      return json({ error: "Ads-Report nicht lesbar", detail: String(e) }, 502);
    }

    const isProvisional = istVorlaeufig(endDate);
    const dataTimestamp = new Date().toISOString();

    // Reihenfolge Pflicht (Unique-Index one_latest_per_report): erst altes
    // is_latest zurücksetzen, dann einfügen.
    const { error: updErr } = await supabase
      .from("report_data")
      .update({ is_latest: false })
      .eq("tenant_id", tenant_id)
      .eq("source", "ads")
      .eq("report_type", REPORT_TYPE)
      .eq("is_latest", true);
    if (updErr) {
      await markJobFatal(supabase, tenant_id, reportId, updErr.message);
      return json({ error: "is_latest zurücksetzen fehlgeschlagen", detail: updErr.message }, 500);
    }

    const { error: insErr } = await supabase.from("report_data").insert({
      tenant_id,
      source: "ads",
      report_type: REPORT_TYPE,
      payload: { format: "ads_v3", rows },
      data_timestamp: dataTimestamp,
      is_provisional: isProvisional,
      is_latest: true,
    });
    if (insErr) {
      await markJobFatal(supabase, tenant_id, reportId, insErr.message);
      return json({ error: "Speichern fehlgeschlagen", detail: insErr.message }, 500);
    }

    await supabase
      .from("report_jobs")
      .update({ status: "DONE", data_timestamp: dataTimestamp, completed_at: new Date().toISOString() })
      .eq("tenant_id", tenant_id)
      .eq("amazon_report_id", reportId);

    return json({
      ok: true,
      status: "DONE",
      report_id: reportId,
      report_type: REPORT_TYPE,
      zeilen: rows.length,
      is_provisional: isProvisional,
      dauer_s: Math.round((Date.now() - startedAt) / 1000),
      hinweis: "Ads-Report abgeholt und gespeichert. Kennzahlen über MCP-Tool get_ads_overview.",
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

async function erstelleReport(
  headers: Record<string, string>,
  reqBody: unknown,
  deadline: number
): Promise<{ ok: boolean; reportId?: string; detail?: unknown }> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(`${ADS_ENDPOINT}/reporting/reports`, {
      method: "POST",
      headers: { ...headers, "Content-Type": V3_CONTENT_TYPE, "Accept": V3_CONTENT_TYPE },
      body: JSON.stringify(reqBody),
    });
    if (resp.status === 429) {
      if (Date.now() + RATE_LIMIT_WAIT_MS >= deadline) return { ok: false, detail: "429 und Zeitbudget aufgebraucht" };
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, detail: data };
    return { ok: true, reportId: data.reportId };
  }
  return { ok: false, detail: "429 auch nach mehreren Versuchen" };
}

async function pollReport(
  headers: Record<string, string>,
  reportId: string,
  deadline: number
): Promise<{ ok: boolean; status?: string; url?: string; detail?: unknown }> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(`${ADS_ENDPOINT}/reporting/reports/${reportId}`, { method: "GET", headers });
    if (resp.status === 429) {
      if (Date.now() + RATE_LIMIT_WAIT_MS >= deadline) return { ok: true, status: "PROCESSING" };
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, detail: data };
    return { ok: true, status: data.status, url: data.url ?? data.location ?? undefined };
  }
  return { ok: true, status: "PROCESSING" };
}

async function markJobFatal(supabase: any, tenant_id: string, reportId: string, detail: unknown): Promise<void> {
  await supabase
    .from("report_jobs")
    .update({
      status: "FATAL",
      error_detail: String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 2000),
      completed_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenant_id)
    .eq("amazon_report_id", reportId);
}

async function getAccessToken(cid: string, csec: string, rt: string): Promise<string | null> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: cid, client_secret: csec });
  const resp = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token ?? null;
}

async function readSecret(supabase: any, secretId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_secret_id: secretId });
  if (error || !data) return null;
  return data as string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

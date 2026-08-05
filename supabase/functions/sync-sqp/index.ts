// sync-sqp — Brand-Analytics Search Query Performance Report für EINE ASIN und
// EINEN Zeitraum ziehen.
// createReport -> pollen -> Dokument (GZIP-JSON) laden -> parseSqpReport -> sqp_rows.
// Aufruf wie die anderen Syncs: POST { tenant_id, asin } mit service_role-Bearer,
// optional { periode: "WEEK"|"MONTH", von: "YYYY-MM-DD" }. Ohne Zeitraum wird die
// letzte abgeschlossene Woche geholt (so ruft der tägliche Cron auf).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { alsPeriode, letzterZeitraum, parseSqpReport, type Periode, type Zeitraum, zeitraumFuer } from "../_shared/sqp.ts";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";
const REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT";
const POLL_MS = 5000;
const DEADLINE_MS = 130000;

Deno.serve(async (req) => {
  const start = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, asin } = body;
    if (!tenant_id || !asin) return json({ error: "tenant_id und asin nötig" }, 400);

    // Periode + Zeitraum bestimmen. Die Grenzen kommen IMMER aus zeitraumFuer —
    // Amazon lehnt Zeiträume ab, die nicht genau auf der Periode liegen.
    const periode = alsPeriode(body.periode);
    const zeitraum = body.von ? zeitraumSicher(periode, String(body.von)) : letzterZeitraum(periode);
    if (!zeitraum) return json({ error: "Zeitraum ungültig — 'von' als YYYY-MM-DD erwartet", von: body.von }, 400);
    const { von, bis } = zeitraum;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: ctx, error: ctxErr } = await supabase.from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, marketplace_id")
      .eq("tenant_id", tenant_id).eq("source", "sp").single();
    if (ctxErr || !ctx) return json({ error: "auth_context nicht gefunden" }, 404);

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) return json({ error: "Vault-Werte fehlen" }, 500);
    const accessToken = await holeAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    // 1) Report anfordern
    const createResp = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports`, {
      method: "POST",
      headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        reportType: REPORT_TYPE,
        marketplaceIds: [ctx.marketplace_id],
        // Beide Grenzen um Mitternacht — genau so nimmt Amazon den Zeitraum an.
        // Mit T23:59:59Z am Ende kommt der Report als FATAL zurück.
        dataStartTime: `${von}T00:00:00Z`, dataEndTime: `${bis}T00:00:00Z`,
        reportOptions: { reportPeriod: periode, asin },
      }),
    });
    const createData = await createResp.json().catch(() => ({}));
    if (!createResp.ok) return json({ error: "createReport Fehler", status: createResp.status, detail: createData }, 502);
    const reportId = createData.reportId;

    // 2) Pollen bis DONE
    let documentId: string | null = null;
    let processingStatus = "IN_QUEUE";
    while (Date.now() - start < DEADLINE_MS) {
      await schlaf(POLL_MS);
      const st = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports/${reportId}`, { headers: { "x-amz-access-token": accessToken } });
      const stData = await st.json().catch(() => ({}));
      processingStatus = stData.processingStatus ?? processingStatus;
      if (processingStatus === "DONE") { documentId = stData.reportDocumentId ?? null; break; }
      if (processingStatus === "FATAL" || processingStatus === "CANCELLED") {
        return json({ error: "Report fehlgeschlagen", processingStatus, report_id: reportId }, 502);
      }
    }
    if (processingStatus !== "DONE") {
      return json({ ok: false, hinweis: "Report noch nicht fertig — später mit report_id erneut", report_id: reportId, processingStatus }, 202);
    }
    if (!documentId) return json({ ok: true, asin, zeilen: 0, hinweis: "Report DONE ohne Dokument (keine Daten)" });

    // 3) Dokument laden + entpacken (GZIP-JSON). getReportDocument hat ein sehr
    // striktes Limit (~1/min) -> bei 429 kurz warten und erneut.
    let docData: any = null;
    for (let versuch = 0; versuch < 3; versuch++) {
      const dr = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/documents/${documentId}`, { headers: { "x-amz-access-token": accessToken } });
      if (dr.status === 429) { await schlaf(20000); continue; }
      docData = await dr.json().catch(() => ({}));
      if (!dr.ok) return json({ error: "getReportDocument Fehler", detail: docData }, 502);
      break;
    }
    if (!docData) return json({ ok: false, hinweis: "getReportDocument 429 — später erneut", report_id: reportId }, 202);
    const fileResp = await fetch(docData.url);
    if (!fileResp.ok) return json({ error: `Datei-Download HTTP ${fileResp.status}` }, 502);
    let bytes: Uint8Array;
    if (docData.compressionAlgorithm === "GZIP") {
      const buf = new Uint8Array(await fileResp.arrayBuffer());
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      bytes = new Uint8Array(await fileResp.arrayBuffer());
    }
    const report = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    const zeilen = parseSqpReport(report);

    // 4) Speichern: nur die Zeilen DIESES Zeitraums ersetzen — ältere Wochen und
    // Monate bleiben stehen, damit man in der App zurückblättern kann.
    await supabase.from("sqp_rows").delete()
      .eq("tenant_id", tenant_id).eq("asin", asin).eq("periode", periode).eq("zeitraum_von", von);
    if (zeilen.length > 0) {
      const jetzt = new Date().toISOString();
      const { error: insErr } = await supabase.from("sqp_rows").insert(
        zeilen.map((z) => ({ tenant_id, asin, periode, ...z, zeitraum_von: von, zeitraum_bis: bis, updated_at: jetzt })),
      );
      if (insErr) return json({ error: "Insert fehlgeschlagen", detail: insErr.message }, 500);
    }
    return json({ ok: true, asin, periode, zeilen: zeilen.length, zeitraum: { von, bis } });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

/** Wie zeitraumFuer, gibt bei unbrauchbarem Datum aber null statt zu werfen. */
function zeitraumSicher(periode: Periode, datum: string): Zeitraum | null {
  try {
    return zeitraumFuer(periode, datum);
  } catch {
    return null;
  }
}

async function holeAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string | null> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  const resp = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  return resp.ok ? (data.access_token ?? null) : null;
}

async function readSecret(supabase: any, secretId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_secret_id: secretId });
  return error || !data ? null : (data as string);
}
function schlaf(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// request-report
// Stufe 1: Fordert einen GET_SALES_AND_TRAFFIC_REPORT bei Amazon an (letzte 14 Tage).
// Speichert die erhaltene reportId als report_jobs-Eintrag (status PROCESSING).
// Input: { tenant_id }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";

Deno.serve(async (req) => {
  try {
    const { tenant_id } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: ctx, error: ctxErr } = await supabase
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, marketplace_id")
      .eq("tenant_id", tenant_id)
      .eq("source", "sp")
      .single();
    if (ctxErr || !ctx) return json({ error: "auth_context nicht gefunden", detail: ctxErr?.message }, 404);

    const clientId     = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken)
      return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);

    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 14);

    const reportBody = {
      reportType: "GET_SALES_AND_TRAFFIC_REPORT",
      marketplaceIds: [ctx.marketplace_id],
      dataStartTime: start.toISOString(),
      dataEndTime: end.toISOString(),
      reportOptions: { dateGranularity: "DAY", asinGranularity: "CHILD" },
    };

    const resp = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports`, {
      method: "POST",
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportBody),
    });

    const data = await resp.json();
    if (!resp.ok) return json({ error: "SP-API Fehler", status: resp.status, detail: data }, 502);

    const reportId = data.reportId;
    const { error: insErr } = await supabase.from("report_jobs").insert({
      tenant_id,
      source: "sp",
      report_type: "GET_SALES_AND_TRAFFIC_REPORT",
      status: "PROCESSING",
      amazon_report_id: reportId,
    });
    if (insErr) return json({ error: "Job speichern fehlgeschlagen", detail: insErr.message }, 500);

    return json({ ok: true, reportId, hinweis: "Report angefordert. Als Nächstes Status prüfen." });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

async function getAccessToken(cid: string, csec: string, rt: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: rt, client_id: cid, client_secret: csec,
  });
  const resp = await fetch("https://api.amazon.com/auth/o2/token", {
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

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

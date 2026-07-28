// check-report
// Stufe 2: Fragt den Verarbeitungsstatus eines Reports ab.
// Bei DONE liefert Amazon eine reportDocumentId (für den Download in Stufe 3).
// Aktualisiert den report_jobs-Eintrag.
// Input: { tenant_id, report_id }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";

Deno.serve(async (req) => {
  try {
    const { tenant_id, report_id } = await req.json();
    if (!tenant_id || !report_id) return json({ error: "tenant_id oder report_id fehlt" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: ctx, error: ctxErr } = await supabase
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret")
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

    const resp = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports/${report_id}`, {
      method: "GET",
      headers: { "x-amz-access-token": accessToken },
    });
    const data = await resp.json();
    if (!resp.ok) return json({ error: "SP-API Fehler", status: resp.status, detail: data }, 502);

    const status = data.processingStatus;

    await supabase.from("report_jobs")
      .update({
        status: status === "DONE" ? "DONE" : (status === "FATAL" || status === "CANCELLED" ? "FATAL" : "PROCESSING"),
        report_document_id: data.reportDocumentId ?? null,
      })
      .eq("tenant_id", tenant_id)
      .eq("amazon_report_id", report_id);

    return json({
      ok: true,
      processingStatus: status,
      reportDocumentId: data.reportDocumentId ?? null,
      hinweis: status === "DONE"
        ? "Report fertig! reportDocumentId für den Download nutzen."
        : `Report-Status: ${status}. Bei IN_PROGRESS/IN_QUEUE in 1-2 Min erneut prüfen.`,
    });
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

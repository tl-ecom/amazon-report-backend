// fetch-report
// Stufe 3: Lädt das fertige Report-Dokument herunter, entpackt (gzip), parst JSON,
// und speichert es in report_data (setzt altes is_latest=false, neues is_latest=true).
// Input: { tenant_id, report_document_id }

import { createClient } from "jsr:@supabase/supabase-js@2";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";

Deno.serve(async (req) => {
  try {
    const { tenant_id, report_document_id } = await req.json();
    if (!tenant_id || !report_document_id)
      return json({ error: "tenant_id oder report_document_id fehlt" }, 400);

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

    // 1) Download-Info holen
    const docResp = await fetch(
      `${SP_ENDPOINT}/reports/2021-06-30/documents/${report_document_id}`,
      { method: "GET", headers: { "x-amz-access-token": accessToken } }
    );
    const docData = await docResp.json();
    if (!docResp.ok) return json({ error: "Dokument-Info Fehler", status: docResp.status, detail: docData }, 502);

    const url = docData.url;
    const compression = docData.compressionAlgorithm ?? null;

    // 2) Daten holen
    const fileResp = await fetch(url);
    if (!fileResp.ok) return json({ error: "Datei-Download Fehler", status: fileResp.status }, 502);

    let text: string;
    if (compression === "GZIP") {
      const buf = new Uint8Array(await fileResp.arrayBuffer());
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      text = await new Response(stream).text();
    } else {
      text = await fileResp.text();
    }

    // 3) JSON parsen (Sales & Traffic ist JSON; TSV-Reports fallen auf raw zurück)
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 100000) };
    }

    // 4) Speichern
    await supabase.from("report_data")
      .update({ is_latest: false })
      .eq("tenant_id", tenant_id)
      .eq("source", "sp")
      .eq("report_type", "GET_SALES_AND_TRAFFIC_REPORT");

    const { error: insErr } = await supabase.from("report_data").insert({
      tenant_id,
      source: "sp",
      report_type: "GET_SALES_AND_TRAFFIC_REPORT",
      payload,
      data_timestamp: new Date().toISOString(),
      is_latest: true,
    });
    if (insErr) return json({ error: "Speichern fehlgeschlagen", detail: insErr.message }, 500);

    const preview = typeof payload === "object" && payload !== null
      ? Object.keys(payload as Record<string, unknown>)
      : [];

    return json({
      ok: true,
      hinweis: "Echte Amazon-Daten gespeichert!",
      compression,
      datenstruktur_schluessel: preview,
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

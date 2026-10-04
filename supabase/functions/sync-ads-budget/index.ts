// sync-ads-budget — Budget-Auslastung der aktiven SP-Kampagnen, stündlich.
//
// Fragt Amazons Budget-Usage-API, wie viel Prozent des Tagesbudgets jede aktive
// Kampagne gerade verbraucht hat, und legt die Messungen ab der Schwelle in
// ads_budget_auslastung ab. Warum und mit welchen Grenzen: _shared/ads_budget.ts.
//
// Reines Lesen bei Amazon. Der Schreibpfad in die Ads-API bleibt allein in
// ads-gebote.
//
// Die Kampagnen-IDs kommen aus dem letzten Struktur-Snapshot (ads_kampagnen),
// nicht aus einem eigenen Listenaufruf: der Snapshot ist höchstens einen Tag
// alt, und eine heute angelegte Kampagne fehlt dann eben bis morgen.
//
// Spec (Advertising API, Sponsored Products):
//   POST /sp/campaigns/budget/usage   { campaignIds: [...] }   max. 100 je Aufruf
//   Content-Type / Accept: application/vnd.spcampaignbudgetusage.v1+json
//   Antwort: { success: [{ campaignId, budgetUsagePercent, budget,
//              usageUpdatedTimestamp, index }], error: [...] }
//
// Jeder Lauf schreibt eine Zeile in report_jobs (sp-budget-auslastung) — auch
// wenn keine Kampagne über der Schwelle liegt. Sonst wäre "keine Zeile" nicht
// von "nicht gemessen" zu unterscheiden.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { AUSGESCHOEPFT, baueAuslastungRows, SCHWELLE, type UsageEintrag } from "../_shared/ads_budget.ts";

const ADS_ENDPOINT = "https://advertising-api-eu.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CT = "application/vnd.spcampaignbudgetusage.v1+json";
const BLOCK = 100;
const REPORT_TYP = "sp-budget-auslastung";

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id: string | undefined = body.tenant_id;
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: ctx, error: ctxErr } = await supabase
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, profile_id")
      .eq("tenant_id", tenant_id).eq("source", "ads").maybeSingle();
    if (ctxErr) return json({ error: "auth_context-Lookup fehlgeschlagen", detail: ctxErr.message }, 500);
    if (!ctx?.profile_id) return json({ error: "Kein ads-auth_context für diesen Tenant" }, 404);

    // Marktplatz und Profil wie in sync-ads-struktur: ohne Angabe das
    // verbundene Profil, sonst das freigeschaltete Profil dieses Marktplatzes.
    const gewuenscht = String(body.marktplatz ?? "").trim() || null;
    let profileId = String(ctx.profile_id);
    let marktplatz = "A1PA6795UKMFR9";
    const { data: profile } = await supabase.from("ads_profile")
      .select("profile_id, marktplatz, aktiv").eq("tenant_id", tenant_id);
    const eigenes = (profile ?? []).find((p: any) => String(p.profile_id) === String(ctx.profile_id));
    if (eigenes?.marktplatz) marktplatz = String(eigenes.marktplatz);
    if (gewuenscht) {
      const treffer = (profile ?? []).find((p: any) => String(p.marktplatz) === gewuenscht);
      if (!treffer) return json({ error: `Kein Werbe-Profil fuer Marktplatz ${gewuenscht}` }, 404);
      if (treffer.aktiv !== true) return json({ error: `Das Profil fuer ${gewuenscht} ist nicht freigeschaltet.` }, 409);
      profileId = String(treffer.profile_id);
      marktplatz = String(treffer.marktplatz);
    }

    // Aktive Kampagnen aus dem letzten Snapshot dieses Marktplatzes.
    const { data: standRow } = await supabase.from("ads_kampagnen").select("gesehen_am")
      .eq("tenant_id", tenant_id).eq("marktplatz", marktplatz)
      .order("gesehen_am", { ascending: false }).limit(1).maybeSingle();
    if (!standRow) return json({ ok: true, status: "KEIN_SNAPSHOT", hinweis: "Noch kein Struktur-Snapshot — keine Kampagnen bekannt." });
    const { data: kampagnen, error: kErr } = await supabase.from("ads_kampagnen").select("campaign_id")
      .eq("tenant_id", tenant_id).eq("marktplatz", marktplatz)
      .eq("gesehen_am", standRow.gesehen_am).eq("state", "ENABLED");
    if (kErr) return json({ error: "ads_kampagnen", detail: kErr.message }, 500);
    const ids = (kampagnen ?? []).map((k: any) => String(k.campaign_id));
    if (ids.length === 0) return json({ ok: true, status: "KEINE_KAMPAGNEN", marktplatz });

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    const headers = {
      "Amazon-Advertising-API-ClientId": clientId,
      "Amazon-Advertising-API-Scope": profileId,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": CT,
      "Accept": CT,
    };

    const gemessen_am = new Date().toISOString();
    const erfolge: UsageEintrag[] = [];
    let fehlerAmazon = 0;
    let probe: unknown = null;
    for (let i = 0; i < ids.length; i += BLOCK) {
      const r = await ruf(headers, ids.slice(i, i + BLOCK));
      if (!r.ok) {
        // Ein halber Lauf mit frischem Stempel sähe aus wie ein vollständiger.
        await supabase.from("report_jobs").insert({
          tenant_id, source: "ads", report_type: REPORT_TYP, status: "FATAL",
          error_detail: JSON.stringify(r.detail).slice(0, 2000),
          completed_at: new Date().toISOString(), config: { marktplatz },
        });
        return json({ error: "Budget-Usage-API", detail: r.detail }, 502);
      }
      if (probe === null) probe = Array.isArray(r.data?.success) ? r.data.success.slice(0, 2) : r.data;
      erfolge.push(...(Array.isArray(r.data?.success) ? r.data.success : []));
      fehlerAmazon += Array.isArray(r.data?.error) ? r.data.error.length : 0;
    }

    const rows = baueAuslastungRows(tenant_id, marktplatz, erfolge, gemessen_am);
    if (rows.length > 0) {
      const { error } = await supabase.from("ads_budget_auslastung")
        .upsert(rows, { onConflict: "tenant_id,marktplatz,campaign_id,gemessen_am" });
      if (error) return json({ error: "ads_budget_auslastung", detail: error.message }, 500);
    }

    const ausgeschoepft = rows.filter((r) => Number(r.auslastung_prozent) >= AUSGESCHOEPFT).length;
    await supabase.from("report_jobs").insert({
      tenant_id, source: "ads", report_type: REPORT_TYP, status: "DONE",
      data_timestamp: gemessen_am, completed_at: new Date().toISOString(),
      config: {
        marktplatz, kampagnen: ids.length, gemessen: erfolge.length,
        ab_schwelle: rows.length, ausgeschoepft, fehler_amazon: fehlerAmazon,
      },
    });

    return json({
      ok: true, status: "DONE", marktplatz, gemessen_am,
      kampagnen: ids.length, gemessen: erfolge.length, schwelle: SCHWELLE,
      ab_schwelle: rows.length, ausgeschoepft, fehler_amazon: fehlerAmazon,
      // Zwei Rohzeilen aus Amazons Antwort — damit die Form nachprüfbar bleibt.
      probe,
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

/** Ein Block von höchstens 100 Kampagnen. 429 → kurz warten, bis zu drei Versuche. */
async function ruf(
  headers: Record<string, string>, campaignIds: string[],
): Promise<{ ok: true; data: any } | { ok: false; detail: unknown }> {
  let letzter: unknown = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    const resp = await fetch(`${ADS_ENDPOINT}/sp/campaigns/budget/usage`, {
      method: "POST", headers, body: JSON.stringify({ campaignIds }),
    });
    if (resp.status === 429) { await sleep(3000 * (versuch + 1)); letzter = { status: 429 }; continue; }
    const parsed = await resp.json().catch(() => ({}));
    // 207 Multi-Status ist der Normalfall dieses Endpunkts.
    if (!resp.ok && resp.status !== 207) return { ok: false, detail: { status: resp.status, ...(typeof parsed === "object" ? parsed : { body: parsed }) } };
    return { ok: true, data: parsed };
  }
  return { ok: false, detail: letzter ?? "429 auch nach mehreren Versuchen" };
}

async function getAccessToken(cid: string, csec: string, rt: string): Promise<string | null> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: cid, client_secret: csec });
  const resp = await fetch(LWA_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: body.toString(),
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => ({}));
  return data.access_token ?? null;
}

async function readSecret(supabase: any, secretId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_secret_id: secretId });
  if (error || !data) return null;
  return data as string;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

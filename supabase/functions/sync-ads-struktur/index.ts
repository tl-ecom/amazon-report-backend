// sync-ads-struktur — Aufbau des Werbekontos als täglicher Snapshot.
//
// Holt über die /list-Endpunkte der Advertising API v3 alles, was sonst in der
// Bulk-Datei steht: Kampagnen (Budget, Gebotsstrategie, Platzierungs-Modifier),
// Anzeigengruppen (Standardgebot), Keywords und Product-Targets (Gebot,
// Zustand), Negatives auf Anzeigengruppen- und Kampagnenebene.
//
// Reines Lesen. Der Schreibpfad in die Ads-API bleibt allein in ads-gebote.
//
// Alle Zeilen eines Laufs tragen denselben gesehen_am-Stempel. Was Amazon nicht
// mehr liefert, bekommt keinen neuen Stempel und fällt beim Lesen aus dem
// aktuellen Stand (siehe _shared/ads_struktur.ts).
//
// Spec (verifiziert 2026-09 in ads-gebote):
//   POST /sp/campaigns/list                   application/vnd.spCampaign.v3+json
//   POST /sp/adGroups/list                    application/vnd.spAdGroup.v3+json
//   POST /sp/keywords/list                    application/vnd.spKeyword.v3+json
//   POST /sp/targets/list                     application/vnd.spTargetingClause.v3+json
//   POST /sp/negativeKeywords/list            application/vnd.spNegativeKeyword.v3+json
//   POST /sp/negativeTargets/list             application/vnd.spNegativeTargetingClause.v3+json
//   POST /sp/campaignNegativeKeywords/list    application/vnd.spCampaignNegativeKeyword.v3+json
//   POST /sp/campaignNegativeTargets/list     application/vnd.spCampaignNegativeTargetingClause.v3+json
//   Alle paginieren über nextToken, max 1000 je Seite.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  baueAnzeigengruppenRows,
  baueKampagnenRows,
  baueZieleRows,
  type StrukturRohdaten,
} from "../_shared/ads_struktur.ts";

const ADS_ENDPOINT = "https://advertising-api-eu.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SEITE = 1000;
const MAX_SEITEN = 100;

// Archivierte Objekte bleiben draußen: sie sind bei Amazon endgültig, und ein
// Konto mit Jahren Geschichte hätte sonst Zehntausende tote Zeilen im Snapshot.
const ZUSTAENDE = ["ENABLED", "PAUSED"];

interface Endpunkt {
  schluessel: keyof StrukturRohdaten;
  pfad: string;
  ct: string;
  feld: string;
  mitZustand: boolean;
}

const ENDPUNKTE: Endpunkt[] = [
  { schluessel: "kampagnen", pfad: "/sp/campaigns/list", ct: "application/vnd.spCampaign.v3+json", feld: "campaigns", mitZustand: true },
  { schluessel: "anzeigengruppen", pfad: "/sp/adGroups/list", ct: "application/vnd.spAdGroup.v3+json", feld: "adGroups", mitZustand: true },
  { schluessel: "keywords", pfad: "/sp/keywords/list", ct: "application/vnd.spKeyword.v3+json", feld: "keywords", mitZustand: true },
  { schluessel: "targets", pfad: "/sp/targets/list", ct: "application/vnd.spTargetingClause.v3+json", feld: "targetingClauses", mitZustand: true },
  { schluessel: "negativeKeywords", pfad: "/sp/negativeKeywords/list", ct: "application/vnd.spNegativeKeyword.v3+json", feld: "negativeKeywords", mitZustand: true },
  { schluessel: "negativeTargets", pfad: "/sp/negativeTargets/list", ct: "application/vnd.spNegativeTargetingClause.v3+json", feld: "negativeTargetingClauses", mitZustand: true },
  { schluessel: "kampagnenNegativeKeywords", pfad: "/sp/campaignNegativeKeywords/list", ct: "application/vnd.spCampaignNegativeKeyword.v3+json", feld: "campaignNegativeKeywords", mitZustand: true },
  { schluessel: "kampagnenNegativeTargets", pfad: "/sp/campaignNegativeTargets/list", ct: "application/vnd.spCampaignNegativeTargetingClause.v3+json", feld: "campaignNegativeTargetingClauses", mitZustand: true },
];

Deno.serve(async (req) => {
  const startedAt = Date.now();
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

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);

    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    const headers = {
      "Amazon-Advertising-API-ClientId": clientId,
      "Amazon-Advertising-API-Scope": ctx.profile_id,
      "Authorization": `Bearer ${accessToken}`,
    };

    // ---- Stufe 1: alles einsammeln. Ein Fehler bricht ab — ein halber
    // Snapshot mit frischem Stempel sähe aus wie ein vollständiger.
    const roh: StrukturRohdaten = {
      kampagnen: [], anzeigengruppen: [], keywords: [], targets: [],
      negativeKeywords: [], negativeTargets: [], kampagnenNegativeKeywords: [], kampagnenNegativeTargets: [],
    };
    const fehler: Record<string, unknown> = {};
    for (const e of ENDPUNKTE) {
      const filter = e.mitZustand ? { stateFilter: { include: ZUSTAENDE } } : {};
      const r = await alle(headers, e.pfad, e.ct, filter, e.feld);
      if (!r.ok) {
        fehler[e.schluessel] = r.detail;
        continue;
      }
      roh[e.schluessel] = r.daten;
    }
    if (Object.keys(fehler).length) {
      await supabase.from("report_jobs").insert({
        tenant_id, source: "ads", report_type: "sp-struktur", status: "FATAL",
        error_detail: JSON.stringify(fehler).slice(0, 2000), completed_at: new Date().toISOString(),
      });
      return json({ error: "Struktur unvollständig geladen — nichts geschrieben", fehler }, 502);
    }

    // ---- Stufe 2: schreiben. Ein Stempel für den ganzen Lauf.
    const gesehen_am = new Date().toISOString();
    const kampagnen = baueKampagnenRows(tenant_id, roh.kampagnen, gesehen_am);
    const gruppen = baueAnzeigengruppenRows(tenant_id, roh.anzeigengruppen, gesehen_am);
    const ziele = baueZieleRows(tenant_id, roh, gesehen_am);

    const schreib = [
      await upsert(supabase, "ads_kampagnen", "tenant_id,campaign_id", kampagnen),
      await upsert(supabase, "ads_anzeigengruppen", "tenant_id,ad_group_id", gruppen),
      await upsert(supabase, "ads_ziele", "tenant_id,art,ziel_id", ziele),
    ];
    const schreibFehler = schreib.filter((s) => s.fehler).map((s) => s.fehler);

    await supabase.from("report_jobs").insert({
      tenant_id, source: "ads", report_type: "sp-struktur",
      status: schreibFehler.length ? "FATAL" : "DONE",
      error_detail: schreibFehler.length ? schreibFehler.join("; ").slice(0, 2000) : null,
      data_timestamp: gesehen_am, completed_at: new Date().toISOString(),
      config: { kampagnen: kampagnen.length, anzeigengruppen: gruppen.length, ziele: ziele.length },
    });

    if (schreibFehler.length) return json({ error: "Schreiben fehlgeschlagen", detail: schreibFehler }, 500);

    return json({
      ok: true,
      status: "DONE",
      stand: gesehen_am,
      kampagnen: kampagnen.length,
      anzeigengruppen: gruppen.length,
      ziele: ziele.length,
      davon: {
        keywords: roh.keywords.length,
        targets: roh.targets.length,
        negatives: roh.negativeKeywords.length + roh.negativeTargets.length +
          roh.kampagnenNegativeKeywords.length + roh.kampagnenNegativeTargets.length,
      },
      dauer_s: Math.round((Date.now() - startedAt) / 1000),
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

/** Alle Seiten einer /list-Abfrage. 429 → kurz warten, bis zu drei Versuche. */
async function alle(
  headers: Record<string, string>, pfad: string, ct: string, body: Record<string, unknown>, feld: string,
): Promise<{ ok: true; daten: any[] } | { ok: false; detail: unknown }> {
  const out: any[] = [];
  let nextToken: string | undefined;
  for (let seite = 0; seite < MAX_SEITEN; seite++) {
    let data: any = null;
    let letzterFehler: unknown = null;
    for (let versuch = 0; versuch < 3; versuch++) {
      const resp = await fetch(`${ADS_ENDPOINT}${pfad}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": ct, "Accept": ct },
        body: JSON.stringify({ ...body, maxResults: SEITE, ...(nextToken ? { nextToken } : {}) }),
      });
      if (resp.status === 429) { await sleep(3000 * (versuch + 1)); continue; }
      const parsed = await resp.json().catch(() => ({}));
      if (!resp.ok) { letzterFehler = { status: resp.status, pfad, ...(typeof parsed === "object" ? parsed : { body: parsed }) }; break; }
      data = parsed;
      break;
    }
    if (!data) return { ok: false, detail: letzterFehler ?? `${pfad}: 429 auch nach mehreren Versuchen` };
    out.push(...(data?.[feld] ?? []));
    nextToken = data?.nextToken || undefined;
    if (!nextToken) break;
  }
  return { ok: true, daten: out };
}

async function upsert(supabase: any, tabelle: string, onConflict: string, zeilen: Record<string, unknown>[]) {
  const BATCH = 500;
  for (let i = 0; i < zeilen.length; i += BATCH) {
    const { error } = await supabase.from(tabelle).upsert(zeilen.slice(i, i + BATCH), { onConflict });
    if (error) return { fehler: `${tabelle}: ${error.message}` };
  }
  return { fehler: null };
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

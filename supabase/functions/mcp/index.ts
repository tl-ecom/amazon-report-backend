// mcp — MCP-Server (JSON-RPC 2.0 über HTTP, Streamable-HTTP-kompatibel, stateless).
//
// Die KI (ChatGPT/Claude) verbindet sich hierher und ruft die Tools auf. Die
// Protokoll-Logik liegt in _shared/mcp.ts (unit-getestet); diese Datei macht nur:
//   1. Bearer-Token → Tenant auflösen (Auth)
//   2. JSON-RPC-Body ans Kernmodul geben
//   3. report_data für DIESEN Tenant laden (injizierter ladeReport)
//
// verify_jwt = false (in config.toml): MCP-Clients schicken KEINEN Supabase-JWT,
// sondern unseren eigenen Bearer-Token. Die Authentifizierung machen wir hier
// selbst — deshalb darf Supabase den Request nicht vorher wegen fehlendem JWT
// abweisen.
//
// Tenant-Isolation: Der ladeReport-Loader filtert IMMER auf die per Token
// aufgelöste tenant_id. service_role umgeht RLS — die tenant_id kommt NIE aus dem
// Request-Body, nur aus dem authentifizierten Token.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { dispatch, McpContext, protokollFehler } from "../_shared/mcp.ts";
import { ladeVerlaufFactory } from "../_shared/verlauf.ts";
import { produktUebersicht } from "../_shared/produkte.ts";
import { kpiVerlauf } from "../_shared/kpiverlauf.ts";
import { adsVerlauf } from "../_shared/ads_verlauf.ts";
import { ertragVerlauf } from "../_shared/ertrag.ts";
import { listeSqp, sqpAsins } from "../_shared/sqp.ts";
import { listeDiagnosen } from "../_shared/diagnostics.ts";
import { changeEvents } from "../_shared/flightrecorder.ts";
import { strategieUebersicht } from "../_shared/strategie_lauf.ts";
import { mcpPfadRest, mcpRessource, oauthBasis, ressourcenMetadatenUrlFuer } from "../_shared/oauth.ts";

// Browser-basierte MCP-Clients schicken vor dem POST einen CORS-Preflight. Ohne
// diese Header bricht die Verbindung ab, bevor überhaupt ein JSON-RPC-Request
// stattfindet — der Client meldet dann nur „Server nicht erreichbar".
// WWW-Authenticate muss exponiert werden, sonst sieht der Client den Hinweis auf
// die Resource-Metadaten nicht und findet den OAuth-Flow nicht.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // MCP spricht ausschließlich POST. GET/anderes klar abweisen.
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Nur POST" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json", "Allow": "POST" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // --- Auth: Bearer-Token → Tenant ---
  const tenant_id = await tenantAusToken(req, supabase);
  if (!tenant_id) {
    // 401 mit WWW-Authenticate + resource_metadata (RFC 9728), damit MCP-Clients
    // den OAuth-Flow finden. Der statische Bearer-Token (mcp_tokens) bleibt gültig.
    //
    // Die Metadaten-URL nennt die TATSÄCHLICH aufgerufene Ressource inklusive
    // Tenant-Slug. Sonst antwortet der AS mit der blanken Basis-URL, der Client
    // vergleicht sie mit seiner konfigurierten URL und verwirft sie als fremd.
    const ressource = mcpRessource(oauthBasis().resource, mcpPfadRest(new URL(req.url).pathname));
    return new Response(
      JSON.stringify(protokollFehler(null, "Ungültiger oder fehlender Bearer-Token")),
      {
        status: 401,
        headers: {
          ...CORS,
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${ressourcenMetadatenUrlFuer(ressource)}"`,
        },
      }
    );
  }

  // --- Body parsen ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(protokollFehler(null, "Body ist kein gültiges JSON"), 400);
  }

  // Loader ist an DIESEN Tenant gebunden. tenant_id kommt aus dem Token, nie aus dem Body.
  const ctx: McpContext = {
    ladeReport: async (reportType: string, source = "sp") => {
      const { data, error } = await supabase
        .from("report_data")
        .select("payload, data_timestamp, is_provisional")
        .eq("tenant_id", tenant_id)
        .eq("source", source)
        .eq("report_type", reportType)
        .eq("is_latest", true)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    },
    ladeVerlauf: (art, verlaufArgs) => ladeVerlaufFactory(supabase, tenant_id)(art, verlaufArgs),
    // Pulse-Analytics (read-only). tenant_id kommt aus dem Token, nie aus dem Body.
    ladePulse: async (art, pulseArgs) => {
      switch (art) {
        case "produkte": return await produktUebersicht(supabase, tenant_id, pulseArgs);
        case "kpi": return await kpiVerlauf(supabase, tenant_id);
        case "ads_verlauf": return await adsVerlauf(supabase, tenant_id, pulseArgs);
        case "ertrag": return await ertragVerlauf(supabase, tenant_id);
        case "sqp": {
          const asin = String((pulseArgs?.asin as string) ?? "").trim();
          return asin
            ? await listeSqp(supabase, tenant_id, asin, pulseArgs?.periode, pulseArgs?.von)
            : await sqpAsins(supabase, tenant_id);
        }
        case "diagnosen": return await listeDiagnosen(supabase, tenant_id);
        case "aenderungen": return await changeEvents(supabase, tenant_id, { alle: true, ...pulseArgs });
        case "strategie": return await strategieUebersicht(supabase, tenant_id);
        default: return { fehler: `Unbekannte Datenart: ${art}` };
      }
    },
  };

  // MCP erlaubt Batch (Array) oder Einzelnachricht.
  if (Array.isArray(body)) {
    const antworten = [];
    for (const msg of body) {
      const a = await dispatch(msg, ctx);
      if (a !== null) antworten.push(a);
    }
    // Nur Notifications im Batch → 202 ohne Body (MCP-konform).
    if (antworten.length === 0) return new Response(null, { status: 202, headers: CORS });
    return json(antworten);
  }

  const antwort = await dispatch(body as Record<string, unknown>, ctx);
  if (antwort === null) return new Response(null, { status: 202, headers: CORS }); // reine Notification
  return json(antwort);
});

/**
 * Löst den Bearer-Token zu einer tenant_id auf.
 * Der Token wird HIER gehasht (SHA-256); die DB sieht nur den Hash.
 */
async function tenantAusToken(req: Request, supabase: any): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const token = m[1].trim();
  if (!token) return null;

  const hash = await sha256Hex(token);

  // 1) Statischer Token (mcp_tokens) — der bestehende „einfache" Weg.
  const { data: statisch } = await supabase
    .from("mcp_tokens")
    .select("id, tenant_id")
    .eq("token_hash", hash)
    .eq("revoked", false)
    .maybeSingle();
  if (statisch) {
    supabase.from("mcp_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", statisch.id).then(() => {}, () => {});
    return statisch.tenant_id as string;
  }

  // 2) OAuth-Access-Token (oauth_tokens) — Self-Serve-Weg. Muss gültig, nicht
  //    widerrufen und nicht abgelaufen sein.
  const { data: oauth } = await supabase
    .from("oauth_tokens")
    .select("id, tenant_id, access_expires_at")
    .eq("access_hash", hash)
    .eq("revoked", false)
    .maybeSingle();
  if (oauth && new Date(oauth.access_expires_at).getTime() > Date.now()) {
    supabase.from("oauth_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", oauth.id).then(() => {}, () => {});
    return oauth.tenant_id as string;
  }

  return null;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

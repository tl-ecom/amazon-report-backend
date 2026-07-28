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

Deno.serve(async (req) => {
  // MCP spricht ausschließlich POST. GET/anderes klar abweisen.
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Nur POST" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // --- Auth: Bearer-Token → Tenant ---
  const tenant_id = await tenantAusToken(req, supabase);
  if (!tenant_id) {
    // 401 mit WWW-Authenticate, wie es MCP-Clients erwarten.
    return new Response(
      JSON.stringify(protokollFehler(null, "Ungültiger oder fehlender Bearer-Token")),
      { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }
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
  };

  // MCP erlaubt Batch (Array) oder Einzelnachricht.
  if (Array.isArray(body)) {
    const antworten = [];
    for (const msg of body) {
      const a = await dispatch(msg, ctx);
      if (a !== null) antworten.push(a);
    }
    // Nur Notifications im Batch → 202 ohne Body (MCP-konform).
    if (antworten.length === 0) return new Response(null, { status: 202 });
    return json(antworten);
  }

  const antwort = await dispatch(body as Record<string, unknown>, ctx);
  if (antwort === null) return new Response(null, { status: 202 }); // reine Notification
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

  const { data, error } = await supabase
    .from("mcp_tokens")
    .select("id, tenant_id")
    .eq("token_hash", hash)
    .eq("revoked", false)
    .maybeSingle();

  if (error || !data) return null;

  // last_used_at nachziehen — nicht blockierend, Fehler hier sind egal.
  supabase.from("mcp_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(
    () => {},
    () => {}
  );

  return data.tenant_id as string;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

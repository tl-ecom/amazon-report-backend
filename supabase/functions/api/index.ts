// api — Read-Endpunkt für das Web-Frontend (Multi-Tenant, Supabase-Auth).
//
// Anders als `mcp` (Bearer-Token für die KI) authentifiziert dieser Endpunkt per
// Supabase-SESSION-JWT: das Frontend loggt den Nutzer ein und ruft hier mit dessen
// Session-Token. Der Tenant wird aus der IDENTITÄT abgeleitet (my_tenant_id über
// auth.uid()), NIE aus dem Request-Body — genau wie beim MCP-Server.
//
// Nutzt exakt die getesteten Tool-Handler aus _shared/mcp.ts (rufeToolAuf), damit
// Web und KI dieselben Zahlen liefern und die Logik nur an einer Stelle lebt.
//
// verify_jwt = true: Supabase validiert die Session, bevor die Function läuft.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { McpContext, rufeToolAuf, toolNamen } from "../_shared/mcp.ts";
import { ladeVerlaufFactory } from "../_shared/verlauf.ts";
import { asinTimeline, changeEvents, setzeKontext } from "../_shared/flightrecorder.ts";
import { experimentDetail, listeExperimente } from "../_shared/experiments.ts";
import { pulseOverview } from "../_shared/overview.ts";
import { listeTenants, loeseFirmaAuf } from "../_shared/admin.ts";

// CORS: das Frontend läuft auf einer anderen Origin (Lovable/eigene Domain).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ error: "Nicht angemeldet" }, 401);
  }

  // Client im Kontext des eingeloggten Nutzers (User-JWT). Damit läuft
  // my_tenant_id() über dessen auth.uid().
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Ungültige Session" }, 401);
  }

  const { data: myTenant, error: tErr } = await userClient.rpc("my_tenant_id");
  if (tErr) return json({ error: "Tenant-Auflösung fehlgeschlagen", detail: tErr.message }, 500);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body ist kein JSON" }, 400);
  }

  const args: Record<string, unknown> = body?.arguments ?? {};

  // Datenzugriff mit service_role, aber IMMER explizit auf den aufgelösten Tenant
  // gefiltert (service_role umgeht RLS).
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const userId = userData.user.id;

  // Admin-Ressource: alle Firmen für die "Kunde ansehen"-Auswahl. Die RPC gated
  // sich selbst — Nicht-Admins bekommen eine leere Liste.
  if (body?.resource === "admin_tenants") {
    try {
      return json({ ok: true, resource: "admin_tenants", data: await listeTenants(service, userId) });
    } catch (e) {
      return json({ error: "admin_tenants fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Effektive Firma auflösen: eigene, oder — NUR als Admin — die per company_id
  // gewählte. company_id aus dem Body ist für Nicht-Admins wirkungslos.
  const firma = await loeseFirmaAuf(service, userId, myTenant ?? null, body?.company_id);
  if (!firma.tenant) {
    return json({ error: firma.fehler, is_admin: firma.is_admin }, firma.code ?? 403);
  }
  const tenantId = firma.tenant;

  // --- Schreib-Aktionen (Flight Recorder: Kontext bestätigen) ---
  // Bewusst getrennt von den Read-Ressourcen und NICHT über die KI-Tools —
  // Schreiben erfolgt nur durch den eingeloggten Nutzer.
  const action: string | undefined = body?.action;
  if (action) {
    try {
      if (action === "fr_set_context") {
        const r = await setzeKontext(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      return json({ error: "Unbekannte Aktion", action }, 400);
    } catch (e) {
      return json({ error: "Aktion fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  const resource: string | undefined = body?.resource;
  if (!resource) {
    return json({ error: "resource oder action fehlt", verfuegbar: toolNamen() }, 400);
  }

  const ctx: McpContext = {
    ladeReport: async (reportType: string, source = "sp") => {
      const { data, error } = await service
        .from("report_data")
        .select("payload, data_timestamp, is_provisional")
        .eq("tenant_id", tenantId)
        .eq("source", source)
        .eq("report_type", reportType)
        .eq("is_latest", true)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    },
    ladeVerlauf: (art, verlaufArgs) => ladeVerlaufFactory(service, tenantId)(art, verlaufArgs),
  };

  try {
    // Flight-Recorder-Reads (api-eigene Ressourcen, nicht über die KI-Tools).
    if (resource === "fr_change_events") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await changeEvents(service, tenantId, args as any) });
    }
    if (resource === "fr_asin_timeline") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await asinTimeline(service, tenantId, args as any) });
    }
    if (resource === "fr_experiments") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeExperimente(service, tenantId, args as any) });
    }
    if (resource === "fr_experiment_detail") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await experimentDetail(service, tenantId, args as any) });
    }
    if (resource === "pulse_overview") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await pulseOverview(service, tenantId) });
    }
    const ergebnis = await rufeToolAuf(resource, args, ctx);
    return json({ ok: true, resource, tenant_id: tenantId, data: ergebnis });
  } catch (e) {
    return json({ error: "Ressource nicht verfügbar", detail: String(e), verfuegbar: toolNamen() }, 400);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

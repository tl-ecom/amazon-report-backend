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
import { asinTimeline, changeEvents, erfasseManuelleAenderung, frProdukte, setzeKontext } from "../_shared/flightrecorder.ts";
import { bestaetigeStrategie, listeStrategien, setzeReview, strategieHistorie, verwerfeVorschlag } from "../_shared/strategie_flow.ts";
import { laufeStrategie, strategieUebersicht } from "../_shared/strategie_lauf.ts";
import { erzeugeMcpToken, listeMcpTokens, widerrufeMcpToken } from "../_shared/mcp_tokens.ts";
import { experimentDetail, listeExperimente } from "../_shared/experiments.ts";
import { pulseOverview } from "../_shared/overview.ts";
import { diagnosenLauf, listeDiagnosen, setzeDiagnoseStatus } from "../_shared/diagnostics.ts";
import { erstelleTask, listeTasks, setzeTaskStatus, taskAusDiagnose } from "../_shared/tasks.ts";
import { generiereBrief, listeBriefs, setzeCoachNotiz } from "../_shared/brief.ts";
import { ladeFeatures, zugriffErlaubt } from "../_shared/entitlements.ts";
import { erstelleNote, listeNotes, loescheNote, setzeNoteSichtbarkeit } from "../_shared/notes.ts";
import { kpiVerlauf } from "../_shared/kpiverlauf.ts";
import { produktUebersicht } from "../_shared/produkte.ts";
import { anstossenSqp, listeSqp, sqpAsins } from "../_shared/sqp.ts";
import { ertragVerlauf, listeEk, loescheEk, setzeEk } from "../_shared/ertrag.ts";
import { ladeEinstellungen, setzeEinstellungen } from "../_shared/einstellungen.ts";
import { ablehnenKonto, freigebenKonto, ladeEin, legeFirmaAn, listeKunden, listeTarifFeatures, listeTenants, loeseFirmaAuf, meinKonto, setzeTarif, setzeTarifFeature } from "../_shared/admin.ts";

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
  if (body?.resource === "admin_kunden") {
    try {
      return json({ ok: true, resource: "admin_kunden", data: await listeKunden(service, userId) });
    } catch (e) {
      return json({ error: "admin_kunden fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Eigener Konto-Status: MUSS vor der Tenant-Auflösung stehen, denn ein wartendes
  // Konto hat noch keinen Tenant und würde sonst mit 403 abgewiesen.
  if (body?.resource === "mein_konto") {
    try {
      const konto = await meinKonto(service, userId);
      // Kunden bekommen die Feature-Flags ihres Tarifs mit (Admins sehen alles -> null).
      const features = (!konto.is_admin && myTenant) ? await ladeFeatures(service, myTenant) : null;
      return json({ ok: true, resource: "mein_konto", data: { ...konto, features } });
    } catch (e) {
      return json({ error: "mein_konto fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Admin-Freigabe/Ablehnung: ebenfalls FRÜH — ein Admin ohne eigene Firma würde
  // sonst an der Tenant-Auflösung (409 "Bitte Firma wählen") hängenbleiben, bevor
  // er überhaupt jemanden freigeben kann. Die RPC self-gated auf platform_admins.
  if (body?.action === "admin_konto_freigeben" || body?.action === "admin_konto_ablehnen") {
    const zielUser = String((args as any)?.user_id ?? "");
    if (!zielUser) return json({ error: "user_id fehlt" }, 400);
    try {
      const r = body.action === "admin_konto_freigeben"
        ? await freigebenKonto(service, userId, zielUser, (args as any)?.firmenname, (args as any)?.firma_id)
        : await ablehnenKonto(service, userId, zielUser);
      return json({ ok: true, action: body.action, data: r });
    } catch (e) {
      return json({ error: "Aktion fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Tarif-Matrix lesen (Admin).
  if (body?.resource === "tarif_features") {
    try {
      return json({ ok: true, resource: "tarif_features", data: await listeTarifFeatures(service, userId) });
    } catch (e) {
      return json({ error: "tarif_features fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Ein Feature eines Tarifs schalten (Admin).
  if (body?.action === "admin_tarif_feature") {
    const tarif = String((args as any)?.tarif ?? "");
    const feature = String((args as any)?.feature ?? "");
    if (!tarif || !feature) return json({ error: "tarif/feature fehlt" }, 400);
    try {
      const r = await setzeTarifFeature(service, userId, tarif, feature, Boolean((args as any)?.enabled));
      return json({ ok: true, action: body.action, data: r });
    } catch (e) {
      return json({ error: "Feature setzen fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Firma OHNE Mitglied anlegen (Admin) — der Coach verwaltet den Kunden, bevor
  // dieser ein Login hat. Früh, unabhängig von der Tenant-Auflösung.
  if (body?.action === "admin_firma_anlegen") {
    try {
      const r = await legeFirmaAn(service, userId, String((args as any)?.name ?? ""), String((args as any)?.tarif ?? "coaching"));
      return json({ ok: true, action: body.action, data: r });
    } catch (e) {
      return json({ error: "Firma anlegen fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Tarif eines Kunden setzen (Admin). Früh, unabhängig von der Tenant-Auflösung.
  if (body?.action === "admin_setze_tarif") {
    const tid = String((args as any)?.tenant_id ?? "");
    if (!tid) return json({ error: "tenant_id fehlt" }, 400);
    try {
      const r = await setzeTarif(service, userId, tid, String((args as any)?.tarif ?? ""));
      return json({ ok: true, action: body.action, data: r });
    } catch (e) {
      return json({ error: "Tarif setzen fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Direkte Einladung: Admin lädt jemanden per E-Mail ein (Invite-Mail + Sofort-Freigabe).
  if (body?.action === "admin_einladen") {
    const email = String((args as any)?.email ?? "").trim();
    if (!email) return json({ error: "email fehlt" }, 400);
    try {
      const r = await ladeEin(service, userId, email, (args as any)?.firmenname, (args as any)?.firma_id);
      return json({ ok: true, action: body.action, data: r });
    } catch (e) {
      return json({ error: "Einladung fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 400);
    }
  }

  // Effektive Firma auflösen: eigene, oder — NUR als Admin — die per company_id
  // gewählte. company_id aus dem Body ist für Nicht-Admins wirkungslos.
  const firma = await loeseFirmaAuf(service, userId, myTenant ?? null, body?.company_id);
  if (!firma.tenant) {
    return json({ error: firma.fehler, is_admin: firma.is_admin }, firma.code ?? 403);
  }
  const tenantId = firma.tenant;

  // Feature-Gating: Kunden nur auf die in ihrem Tarif aktiven Ressourcen/Aktionen.
  // Admins/Coaches (is_admin) umgehen das. Serverseitig, damit nicht per Direktaufruf
  // umgehbar — nicht nur im Frontend versteckt.
  if (!firma.is_admin) {
    const gateKey = (body?.resource ?? body?.action) as string | undefined;
    const features = await ladeFeatures(service, tenantId);
    if (!zugriffErlaubt(gateKey, features, false)) {
      return json({ error: "In deinem Tarif nicht enthalten.", gesperrt: true }, 403);
    }
  }

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
      if (action === "fr_manuelle_aenderung") {
        const r = await erfasseManuelleAenderung(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      // Strategie-Layer: Bestätigungs-Flow (nur eingeloggter Nutzer, tenant-gescoped).
      if (action === "strategie_bestaetigen") {
        const r = await bestaetigeStrategie(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "strategie_review") {
        const r = await setzeReview(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "strategie_vorschlag_verwerfen") {
        const r = await verwerfeVorschlag(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "strategie_lauf") {
        const r = await laufeStrategie(service, tenantId, userData.user.id);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      // MCP-Zugang (ChatGPT/Claude): Token erzeugen/widerrufen. Klartext nur bei Erzeugung.
      if (action === "mcp_token_erzeugen") {
        const r = await erzeugeMcpToken(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "mcp_token_widerrufen") {
        const r = await widerrufeMcpToken(service, tenantId, userData.user.id, firma.is_admin, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "sqp_laden") {
        const r = await anstossenSqp(service, tenantId, String((args as any)?.asin ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "diagnosen_aktualisieren") {
        const r = await diagnosenLauf(service, tenantId);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "ek_setzen") {
        const r = await setzeEk(service, tenantId, String((args as any)?.asin ?? ""), (args as any)?.ek, String((args as any)?.gueltig_ab ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "ek_loeschen") {
        const r = await loescheEk(service, tenantId, String((args as any)?.id ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "einstellungen_setzen") {
        const r = await setzeEinstellungen(service, tenantId, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "diagnose_status") {
        const r = await setzeDiagnoseStatus(service, tenantId, String((args as any)?.id ?? ""), String((args as any)?.status ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "task_erstellen") {
        const r = await erstelleTask(service, tenantId, userData.user.id, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "task_aus_diagnose") {
        const r = await taskAusDiagnose(service, tenantId, userData.user.id, String((args as any)?.diagnose_id ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "task_status") {
        const r = await setzeTaskStatus(service, tenantId, String((args as any)?.id ?? ""), String((args as any)?.status ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "brief_generieren") {
        const r = await generiereBrief(service, tenantId, userData.user.id);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "brief_notiz") {
        const r = await setzeCoachNotiz(service, tenantId, String((args as any)?.id ?? ""), String((args as any)?.notiz ?? ""));
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      // Coaching-Notizen schreiben: NUR Coach/Admin (der Coachee liest nur freigegebene).
      if (action === "note_erstellen" || action === "note_sichtbarkeit" || action === "note_loeschen") {
        if (!firma.is_admin) return json({ error: "Nur der Coach darf Notizen bearbeiten.", gesperrt: true }, 403);
        if (action === "note_erstellen") {
          const r = await erstelleNote(service, tenantId, userData.user.id, args as any);
          return json({ ok: true, action, tenant_id: tenantId, data: r });
        }
        if (action === "note_sichtbarkeit") {
          const r = await setzeNoteSichtbarkeit(service, tenantId, String((args as any)?.id ?? ""), String((args as any)?.sichtbarkeit ?? ""));
          return json({ ok: true, action, tenant_id: tenantId, data: r });
        }
        const r = await loescheNote(service, tenantId, String((args as any)?.id ?? ""));
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
    if (resource === "fr_produkte") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await frProdukte(service, tenantId) });
    }
    if (resource === "strategien") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeStrategien(service, tenantId) });
    }
    if (resource === "strategie_historie") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await strategieHistorie(service, tenantId, args as any) });
    }
    if (resource === "strategie_uebersicht") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await strategieUebersicht(service, tenantId) });
    }
    if (resource === "mcp_tokens") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeMcpTokens(service, tenantId, userData.user.id, firma.is_admin) });
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
    if (resource === "diagnosen") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeDiagnosen(service, tenantId) });
    }
    if (resource === "tasks") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeTasks(service, tenantId) });
    }
    if (resource === "weekly_briefs") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeBriefs(service, tenantId) });
    }
    if (resource === "coaching_notes") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeNotes(service, tenantId, firma.is_admin) });
    }
    if (resource === "kpi_verlauf") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await kpiVerlauf(service, tenantId) });
    }
    if (resource === "produkt_uebersicht") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await produktUebersicht(service, tenantId, args as any) });
    }
    if (resource === "sqp_asins") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await sqpAsins(service, tenantId) });
    }
    if (resource === "sqp") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeSqp(service, tenantId, String((args as any)?.asin ?? "")) });
    }
    if (resource === "ertrag_verlauf") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await ertragVerlauf(service, tenantId) });
    }
    if (resource === "asin_ek") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await listeEk(service, tenantId) });
    }
    if (resource === "einstellungen") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await ladeEinstellungen(service, tenantId) });
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

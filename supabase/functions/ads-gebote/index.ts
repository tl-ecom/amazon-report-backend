// ads-gebote — Gebote für Sponsored Products LESEN und SETZEN (Advertising API v3).
//
// Der einzige Schreibpfad in die Ads-API. Bewusst NICHT im MCP-Server (mcp /
// mcp-url): ChatGPT & Co. bleiben reine Leser. Aufgerufen wird diese Function
// nur vom lokalen Werkzeug tools/ads_gebote.py (Claude Code / Shell des Coachs).
//
// Auth: Supabase-SESSION-JWT. NUR Plattform-Admin (Coach) — wie connect-ads.
// Tenant: company_id aus dem Body (Coach-Ansicht), sonst die eigene Firma.
//
// Aktionen (body.action):
//   firmen     Firmen mit Ads-Verbindung (zum Auflösen von Namen)
//   kampagnen  SP-Kampagnen des Profils (Filter: status[])
//   gebote     Keywords + Product-Targets der angegebenen Kampagnen mit Gebot
//   vorschau   wie gebote, plus Regel -> geplante Änderungen. Schreibt NICHTS.
//   pruefen    Ist-Gebot und Ist-Zustand zu einer Liste von IDs (Tabellen-Import)
//   setzen     Änderungen anwenden: neues Gebot (neu) und/oder Zustand (state
//              ENABLED|PAUSED). Nur mit bestaetigung=true. Prüft vorher, ob Gebot
//              und Zustand bei Amazon noch den erwarteten Alt-Werten entsprechen —
//              sonst wird die Zeile übersprungen. Jede Zeile landet im
//              ads_gebote_log (wer, wann, was, von->auf, Ergebnis, Grund).
//
// Spec (Advertising API v3, Sponsored Products, verifiziert 2026-09):
//   POST /sp/campaigns/list   Content-Type/Accept application/vnd.spCampaign.v3+json
//   POST /sp/adGroups/list    application/vnd.spAdGroup.v3+json
//   POST /sp/keywords/list    application/vnd.spKeyword.v3+json
//   POST /sp/targets/list     application/vnd.spTargetingClause.v3+json
//   PUT  /sp/keywords         { keywords: [{ keywordId, bid }] }
//   PUT  /sp/targets          { targetingClauses: [{ targetId, bid }] }
//   Listen paginieren über nextToken, max 1000 je Seite. Updates max 1000 je Aufruf.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { istPlattformAdmin } from "../_shared/admin.ts";
import { baueAenderungen, fasseZusammen, type GebotsRegel, type GebotsZeile, MIN_GEBOT, pruefeRegel, targetText } from "../_shared/gebote.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const ADS_ENDPOINT = "https://advertising-api-eu.amazon.com";

const CT = {
  campaign: "application/vnd.spCampaign.v3+json",
  adGroup: "application/vnd.spAdGroup.v3+json",
  keyword: "application/vnd.spKeyword.v3+json",
  target: "application/vnd.spTargetingClause.v3+json",
  negKeyword: "application/vnd.spNegativeKeyword.v3+json",
  campNegKeyword: "application/vnd.spCampaignNegativeKeyword.v3+json",
  sbCampaign: "application/vnd.sbcampaignresource.v4+json",
  sbAdGroup: "application/vnd.sbadgroupresource.v4+json",
};
const SEITE = 1000;
const UPDATE_BLOCK = 500;
const MAX_AENDERUNGEN = 2000; // Schutz gegen versehentliches Konto-weites Umstellen

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  try {
    // --- Wer ruft? Nur der Coach. ---
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) return json({ error: "Nicht angemeldet" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Ungültige Session" }, 401);
    const userId = userData.user.id;

    const service = createClient(SUPABASE_URL, SERVICE_KEY);
    if (!(await istPlattformAdmin(service, userId))) {
      return json({ error: "Nur der Coach darf Gebote lesen oder setzen." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = str(body.action) ?? "";

    if (action === "firmen") {
      const { data, error } = await service
        .from("auth_contexts")
        .select("tenant_id, profile_id, marketplace_id, status, tenants(name)")
        .eq("source", "ads");
      if (error) return json({ error: "Firmen laden fehlgeschlagen", detail: error.message }, 500);
      const firmen = (data ?? []).map((r: any) => ({
        tenant_id: r.tenant_id, name: r.tenants?.name ?? null, profile_id: r.profile_id,
        marketplace_id: r.marketplace_id, status: r.status,
      }));
      return json({ firmen });
    }

    // --- Welche Firma? company_id (Coach-Ansicht) oder eigene. ---
    const { data: myTenant } = await userClient.rpc("my_tenant_id");
    let tenantId: string | null = (myTenant as string) ?? null;
    const companyId = str(body.company_id);
    if (companyId) {
      const { data: firma } = await service.from("tenants").select("id").eq("id", companyId).maybeSingle();
      if (!firma) return json({ error: "Firma nicht gefunden." }, 404);
      tenantId = companyId;
    }
    if (!tenantId) return json({ error: "Bitte eine Firma wählen (company_id)." }, 409);

    // --- Ads-Zugang des Tenants ---
    const { data: ctx, error: ctxErr } = await service
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, profile_id")
      .eq("tenant_id", tenantId).eq("source", "ads").maybeSingle();
    if (ctxErr) return json({ error: "auth_context-Lookup fehlgeschlagen", detail: ctxErr.message }, 500);
    if (!ctx?.profile_id) return json({ error: "Diese Firma hat keine Ads-Verbindung." }, 404);

    const clientId = await readSecret(service, ctx.client_id_secret);
    const clientSecret = await readSecret(service, ctx.client_secret_secret);
    const refreshToken = await readSecret(service, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen (Refresh-Token abgelaufen?)" }, 502);

    const ads = new AdsClient(clientId, ctx.profile_id, accessToken);

    if (action === "kampagnen") {
      const status = liste(body.status, ["ENABLED", "PAUSED"]);
      const r = await ads.kampagnen(status);
      if (!r.ok) return json({ error: "Kampagnen laden fehlgeschlagen", detail: r.detail }, 502);
      return json({ tenant_id: tenantId, profile_id: ctx.profile_id, kampagnen: r.daten });
    }

    if (action === "gebote" || action === "vorschau") {
      const kampagnenIds = liste(body.kampagnen, []);
      if (!kampagnenIds.length) return json({ error: "kampagnen (Liste von campaignId) fehlt." }, 400);
      const status = liste(body.status, ["ENABLED"]);
      const nur = str(body.nur); // "keyword" | "target" | null = beide

      const z = await ads.gebote(kampagnenIds, status, nur);
      if (!z.ok) return json({ error: "Gebote laden fehlgeschlagen", detail: z.detail }, 502);

      if (action === "gebote") {
        return json({ tenant_id: tenantId, anzahl: z.zeilen.length, erben_standard: z.erben, zeilen: z.zeilen, adgroups: z.adGroups });
      }

      const regel = leseRegel(body.regel);
      const fehler = pruefeRegel(regel);
      if (fehler) return json({ error: `Regel ungültig: ${fehler}` }, 400);
      const aend = baueAenderungen(z.zeilen, regel);
      if (aend.length > MAX_AENDERUNGEN) {
        return json({ error: `Zu viele Änderungen (${aend.length} > ${MAX_AENDERUNGEN}). Bitte Kampagnen enger wählen.` }, 400);
      }
      return json({
        tenant_id: tenantId, regel, zusammenfassung: fasseZusammen(aend), erben_standard: z.erben,
        aenderungen: aend,
        hinweis: "Nichts geschrieben. Zum Anwenden: action=setzen mit genau diesen aenderungen und bestaetigung=true.",
      });
    }

    // Aktuellen Stand gezielter Keywords/Targets (für Tabellen-Import: die Tabelle
    // nennt IDs und erwartete Alt-Werte, wir liefern Ist-Gebot und Ist-Zustand).
    if (action === "pruefen") {
      const eingabe = Array.isArray(body.aenderungen) ? body.aenderungen : [];
      const kwIds = eingabe.filter((a: any) => a?.art === "keyword").map((a: any) => String(a.id));
      const tgIds = eingabe.filter((a: any) => a?.art === "target").map((a: any) => String(a.id));
      if (!kwIds.length && !tgIds.length) return json({ error: "aenderungen leer." }, 400);
      const aktuell = await ads.geboteNachId(kwIds, tgIds);
      if (!aktuell.ok) return json({ error: "Aktuellen Stand laden fehlgeschlagen", detail: aktuell.detail }, 502);
      return json({ tenant_id: tenantId, zeilen: aktuell.zeilen });
    }

    if (action === "setzen") {
      if (body.bestaetigung !== true) return json({ error: "bestaetigung=true fehlt. Es wurde NICHTS geschrieben." }, 400);
      const eingabe = Array.isArray(body.aenderungen) ? body.aenderungen : [];
      // Je Zeile: neues Gebot (neu) und/oder neuer Zustand (state). Mindestens eines.
      const gewollt = eingabe
        .map((a: any) => ({
          art: a?.art, id: str(a?.id), alt: Number(a?.gebot),
          neu: a?.neu === undefined || a?.neu === null || a?.neu === "" ? null : Number(a.neu),
          state: a?.state === "PAUSED" || a?.state === "ENABLED" ? a.state : null,
          stateAlt: str(a?.state_alt), grund: str(a?.grund),
        }))
        .filter((a: any) => (a.art === "keyword" || a.art === "target") && a.id
          && (a.state || (a.neu !== null && Number.isFinite(a.neu) && a.neu >= MIN_GEBOT)));
      if (!gewollt.length) return json({ error: "aenderungen leer oder ungültig. Es wurde NICHTS geschrieben." }, 400);
      if (gewollt.length > MAX_AENDERUNGEN) return json({ error: `Zu viele Änderungen (${gewollt.length} > ${MAX_AENDERUNGEN}).` }, 400);

      // Aktuellen Stand bei Amazon holen: nur schreiben, wenn Gebot (und ggf.
      // Zustand) noch dem erwarteten Alt-Wert entsprechen (jemand könnte
      // inzwischen in der Konsole gedreht haben).
      const kwIds = gewollt.filter((a: any) => a.art === "keyword").map((a: any) => a.id);
      const tgIds = gewollt.filter((a: any) => a.art === "target").map((a: any) => a.id);
      const aktuell = await ads.geboteNachId(kwIds, tgIds);
      if (!aktuell.ok) return json({ error: "Aktuellen Stand laden fehlgeschlagen. Es wurde NICHTS geschrieben.", detail: aktuell.detail }, 502);
      const byId = new Map(aktuell.zeilen.map((z) => [`${z.art}:${z.id}`, z]));

      type Schreib = { art: "keyword" | "target"; id: string; neu: number | null; state: string | null; grund: string | null; zeile: GebotsZeile };
      const schreiben: Schreib[] = [];
      const ergebnisse: any[] = [];
      for (const g of gewollt) {
        const z = byId.get(`${g.art}:${g.id}`);
        if (!z) { ergebnisse.push({ ...g, ergebnis: "uebersprungen", detail: "bei Amazon nicht gefunden" }); continue; }
        if (g.neu !== null && Number.isFinite(g.alt) && Math.abs(z.gebot - g.alt) > 0.005) {
          ergebnisse.push({ ...g, ergebnis: "uebersprungen", detail: `Gebot ist inzwischen ${z.gebot}, erwartet ${g.alt}`, text: z.text, campaignId: z.campaignId, adGroupId: z.adGroupId });
          continue;
        }
        if (g.state && g.stateAlt && z.state && z.state !== g.stateAlt) {
          ergebnisse.push({ ...g, ergebnis: "uebersprungen", detail: `Zustand ist inzwischen ${z.state}, erwartet ${g.stateAlt}`, text: z.text, campaignId: z.campaignId, adGroupId: z.adGroupId });
          continue;
        }
        const neu = g.neu !== null && Math.abs(z.gebot - g.neu) > 0.005 ? g.neu : null;
        const state = g.state && z.state !== g.state ? g.state : null;
        if (neu === null && state === null) {
          ergebnisse.push({ ...g, ergebnis: "uebersprungen", detail: "schon so bei Amazon", text: z.text, campaignId: z.campaignId, adGroupId: z.adGroupId });
          continue;
        }
        schreiben.push({ art: g.art, id: g.id, neu, state, grund: g.grund, zeile: z });
      }

      const feld = (s: Schreib, idFeld: string) => ({ [idFeld]: s.id, ...(s.neu !== null ? { bid: s.neu } : {}), ...(s.state ? { state: s.state } : {}) });
      const kw = schreiben.filter((s) => s.art === "keyword");
      const tg = schreiben.filter((s) => s.art === "target");
      const rk = await ads.setzeKeywords(kw.map((s) => feld(s, "keywordId")));
      const rt = await ads.setzeTargets(tg.map((s) => feld(s, "targetId")));
      for (const s of [...kw, ...tg]) {
        const e = (s.art === "keyword" ? rk : rt).get(s.id) ?? { ok: false, detail: "keine Antwort von Amazon" };
        ergebnisse.push({
          art: s.art, id: s.id, campaignId: s.zeile.campaignId, adGroupId: s.zeile.adGroupId, text: s.zeile.text,
          alt: s.zeile.gebot, neu: s.neu, state_alt: s.zeile.state ?? null, state: s.state, grund: s.grund,
          ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : e.detail,
        });
      }

      // Spur: jede Zeile, auch die übersprungenen.
      const logRows = ergebnisse.map((e) => ({
        tenant_id: tenantId, user_id: userId, art: e.art, objekt_id: e.id,
        campaign_id: e.campaignId ?? null, ad_group_id: e.adGroupId ?? null, text: e.text ?? null,
        gebot_alt: Number.isFinite(e.alt) ? e.alt : null, gebot_neu: e.neu ?? null,
        state_alt: e.state_alt ?? e.stateAlt ?? null, state_neu: e.state ?? null,
        ergebnis: e.ergebnis, detail: e.detail ? String(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 1000) : null,
        grund: e.grund ?? str(body.grund),
      }));
      const { error: logErr } = await service.from("ads_gebote_log").insert(logRows);

      const ok = ergebnisse.filter((e) => e.ergebnis === "ok").length;
      const fehler = ergebnisse.filter((e) => e.ergebnis === "fehler").length;
      const ueb = ergebnisse.filter((e) => e.ergebnis === "uebersprungen").length;
      return json({
        tenant_id: tenantId, geschrieben: ok, fehler, uebersprungen: ueb, ergebnisse,
        ...(logErr ? { log_fehler: logErr.message } : {}),
      });
    }

    // ------------------------------------------------------------ Weitere Aktionen
    // Alle Schreibaktionen hier: bestaetigung=true Pflicht, Spur in ads_aenderungen_log.
    const spur = async (rows: any[]) => {
      if (!rows.length) return null;
      const { error } = await service.from("ads_aenderungen_log").insert(rows.map((r) => ({
        tenant_id: tenantId, user_id: userId, grund: r.grund ?? str(body.grund) ?? null, ...r,
      })));
      return error?.message ?? null;
    };
    const bestaetigt = () => body.bestaetigung === true;

    // Platzierungs-Modifier einer SP-Kampagne lesen
    if (action === "platzierung") {
      const ids = liste(body.kampagnen, []);
      if (!ids.length) return json({ error: "kampagnen fehlt." }, 400);
      const r = await ads.kampagnenRoh(ids);
      if (!r.ok) return json({ error: "Kampagnen laden fehlgeschlagen", detail: r.detail }, 502);
      return json({ tenant_id: tenantId, kampagnen: r.daten.map((c: any) => ({
        campaignId: String(c.campaignId), name: c.name, state: c.state,
        strategie: c.dynamicBidding?.strategy ?? null,
        platzierungen: c.dynamicBidding?.placementBidding ?? [],
      })) });
    }

    // Platzierungs-Modifier setzen: {campaignId, placement, prozent}
    if (action === "platzierung_setzen") {
      if (!bestaetigt()) return json({ error: "bestaetigung=true fehlt. Es wurde NICHTS geschrieben." }, 400);
      const cid = str(body.campaignId); const placement = str(body.placement); const prozent = Number(body.prozent);
      if (!cid || !placement || !Number.isFinite(prozent) || prozent < 0 || prozent > 900) return json({ error: "campaignId, placement und prozent (0–900) nötig." }, 400);
      const r = await ads.kampagnenRoh([cid]);
      if (!r.ok || !r.daten.length) return json({ error: "Kampagne nicht gefunden", detail: r.ok ? null : r.detail }, 404);
      const c = r.daten[0];
      const vorher = c.dynamicBidding?.placementBidding ?? [];
      const nachher = vorher.filter((p: any) => p.placement !== placement).concat([{ placement, percentage: prozent }]);
      const put = await ads.put("/sp/campaigns", CT.campaign, "campaigns", "campaignId",
        [{ campaignId: cid, dynamicBidding: { strategy: c.dynamicBidding?.strategy ?? "LEGACY_FOR_SALES", placementBidding: nachher } }]);
      const e = put.get(cid) ?? { ok: false, detail: "keine Antwort" };
      const logErr = await spur([{ aktion: "platzierung_setzen", objekt_art: "campaign", objekt_id: cid, campaign_id: cid,
        vorher: { placementBidding: vorher }, nachher: { placementBidding: nachher }, ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : JSON.stringify(e.detail).slice(0, 1000) }]);
      return json({ campaignId: cid, name: c.name, vorher, nachher, ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : e.detail, ...(logErr ? { log_fehler: logErr } : {}) });
    }

    // SP-Negatives (Anzeigengruppe + Kampagne) lesen
    if (action === "negatives") {
      const ids = liste(body.kampagnen, []);
      if (!ids.length) return json({ error: "kampagnen fehlt." }, 400);
      const ag = await ads.alle("/sp/negativeKeywords/list", CT.negKeyword, { campaignIdFilter: { include: ids } }, "negativeKeywords");
      if (!ag.ok) return json({ error: "Negatives laden fehlgeschlagen", detail: ag.detail }, 502);
      const ck = await ads.alle("/sp/campaignNegativeKeywords/list", CT.campNegKeyword, { campaignIdFilter: { include: ids } }, "campaignNegativeKeywords");
      if (!ck.ok) return json({ error: "Kampagnen-Negatives laden fehlgeschlagen", detail: ck.detail }, 502);
      const m = (x: any, ebene: string) => ({ ebene, keywordId: String(x.keywordId), campaignId: String(x.campaignId), adGroupId: x.adGroupId ? String(x.adGroupId) : null, text: x.keywordText, matchType: x.matchType, state: x.state });
      return json({ tenant_id: tenantId, negatives: [...ag.daten.map((x: any) => m(x, "adgroup")), ...ck.daten.map((x: any) => m(x, "campaign"))] });
    }

    // SP-Keyword anlegen: {campaignId, adGroupId?, keywordText, matchType, bid}
    if (action === "keyword_anlegen") {
      if (!bestaetigt()) return json({ error: "bestaetigung=true fehlt. Es wurde NICHTS geschrieben." }, 400);
      const cid = str(body.campaignId); const text = str(body.keywordText); const mt = str(body.matchType) ?? "EXACT"; const bid = Number(body.bid);
      if (!cid || !text || !Number.isFinite(bid) || bid < MIN_GEBOT) return json({ error: "campaignId, keywordText und bid nötig." }, 400);
      const agId = await ads.anzeigengruppe(cid, str(body.adGroupId));
      if (!agId.ok) return json({ error: agId.detail }, 400);
      // Duplikat-Schutz: gleiches Keyword + Match in der Kampagne?
      const vorhanden = await ads.alle("/sp/keywords/list", CT.keyword, { campaignIdFilter: { include: [cid] }, matchTypeFilter: { include: [mt] } }, "keywords");
      if (!vorhanden.ok) return json({ error: "Keywords prüfen fehlgeschlagen", detail: vorhanden.detail }, 502);
      const dup = vorhanden.daten.find((k: any) => String(k.keywordText).toLowerCase() === text.toLowerCase());
      if (dup) {
        await spur([{ aktion: "keyword_anlegen", objekt_art: "keyword", objekt_id: String(dup.keywordId), campaign_id: cid, nachher: { keywordText: text, matchType: mt, bid }, ergebnis: "uebersprungen", detail: `existiert schon (state ${dup.state}, bid ${dup.bid})` }]);
        return json({ ergebnis: "uebersprungen", detail: "Keyword existiert schon in dieser Kampagne", keyword: { keywordId: String(dup.keywordId), state: dup.state, bid: dup.bid, matchType: dup.matchType } });
      }
      const r = await ads.post("/sp/keywords", CT.keyword, "keywords", [{ campaignId: cid, adGroupId: agId.id, keywordText: text, matchType: mt, state: "ENABLED", bid }]);
      const e = r[0] ?? { ok: false, detail: "keine Antwort" };
      const logErr = await spur([{ aktion: "keyword_anlegen", objekt_art: "keyword", objekt_id: e.id ?? null, campaign_id: cid, nachher: { adGroupId: agId.id, keywordText: text, matchType: mt, bid }, ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : JSON.stringify(e.detail).slice(0, 1000) }]);
      return json({ ergebnis: e.ok ? "ok" : "fehler", keywordId: e.id ?? null, adGroupId: agId.id, detail: e.ok ? null : e.detail, ...(logErr ? { log_fehler: logErr } : {}) });
    }

    // SP-Negative (Anzeigengruppen-Ebene) anlegen: {campaignId, adGroupId?, keywordText, matchType NEGATIVE_EXACT|NEGATIVE_PHRASE}
    if (action === "negative_anlegen") {
      if (!bestaetigt()) return json({ error: "bestaetigung=true fehlt. Es wurde NICHTS geschrieben." }, 400);
      const cid = str(body.campaignId); const text = str(body.keywordText); const mt = str(body.matchType) ?? "NEGATIVE_EXACT";
      if (!cid || !text) return json({ error: "campaignId und keywordText nötig." }, 400);
      const agId = await ads.anzeigengruppe(cid, str(body.adGroupId));
      if (!agId.ok) return json({ error: agId.detail }, 400);
      const vorhanden = await ads.alle("/sp/negativeKeywords/list", CT.negKeyword, { campaignIdFilter: { include: [cid] } }, "negativeKeywords");
      if (!vorhanden.ok) return json({ error: "Negatives prüfen fehlgeschlagen", detail: vorhanden.detail }, 502);
      const dup = vorhanden.daten.find((k: any) => String(k.keywordText).toLowerCase() === text.toLowerCase() && k.matchType === mt);
      if (dup) {
        await spur([{ aktion: "negative_anlegen", objekt_art: "negative_keyword", objekt_id: String(dup.keywordId), campaign_id: cid, nachher: { keywordText: text, matchType: mt }, ergebnis: "uebersprungen", detail: `existiert schon (state ${dup.state})` }]);
        return json({ ergebnis: "uebersprungen", detail: "Negative existiert schon", keyword: { keywordId: String(dup.keywordId), state: dup.state, matchType: dup.matchType } });
      }
      const r = await ads.post("/sp/negativeKeywords", CT.negKeyword, "negativeKeywords", [{ campaignId: cid, adGroupId: agId.id, keywordText: text, matchType: mt, state: "ENABLED" }]);
      const e = r[0] ?? { ok: false, detail: "keine Antwort" };
      const logErr = await spur([{ aktion: "negative_anlegen", objekt_art: "negative_keyword", objekt_id: e.id ?? null, campaign_id: cid, nachher: { adGroupId: agId.id, keywordText: text, matchType: mt }, ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : JSON.stringify(e.detail).slice(0, 1000) }]);
      return json({ ergebnis: e.ok ? "ok" : "fehler", keywordId: e.id ?? null, adGroupId: agId.id, detail: e.ok ? null : e.detail, ...(logErr ? { log_fehler: logErr } : {}) });
    }

    // Sponsored Brands: Kampagnen lesen
    if (action === "sb_kampagnen") {
      const ids = liste(body.kampagnen, []);
      const filter: Record<string, unknown> = ids.length ? { campaignIdFilter: { include: ids } } : { stateFilter: { include: liste(body.status, ["ENABLED", "PAUSED"]) } };
      const r = await ads.alle("/sb/v4/campaigns/list", CT.sbCampaign, filter, "campaigns");
      if (!r.ok) return json({ error: "SB-Kampagnen laden fehlgeschlagen", detail: r.detail }, 502);
      return json({ tenant_id: tenantId, kampagnen: r.daten.map((c: any) => ({
        campaignId: String(c.campaignId), name: c.name, state: c.state, budget: c.budget ?? null, budgetType: c.budgetType ?? null,
        format: c.adFormat ?? c.creative?.type ?? null, start: c.startDate ?? null,
      })) });
    }

    // Sponsored Brands: Kampagnen-Zustand setzen {campaignId, state}
    if (action === "sb_kampagne_zustand") {
      if (!bestaetigt()) return json({ error: "bestaetigung=true fehlt. Es wurde NICHTS geschrieben." }, 400);
      const cid = str(body.campaignId); const state = str(body.state);
      if (!cid || !(state === "PAUSED" || state === "ENABLED")) return json({ error: "campaignId und state (PAUSED|ENABLED) nötig." }, 400);
      const r = await ads.alle("/sb/v4/campaigns/list", CT.sbCampaign, { campaignIdFilter: { include: [cid] } }, "campaigns");
      if (!r.ok || !r.daten.length) return json({ error: "SB-Kampagne nicht gefunden", detail: r.ok ? null : r.detail }, 404);
      const c = r.daten[0];
      if (c.state === state) {
        await spur([{ aktion: "sb_kampagne_zustand", objekt_art: "sb_campaign", objekt_id: cid, campaign_id: cid, vorher: { state: c.state }, nachher: { state }, ergebnis: "uebersprungen", detail: "schon so" }]);
        return json({ campaignId: cid, name: c.name, ergebnis: "uebersprungen", detail: `Kampagne ist schon ${state}` });
      }
      const put = await ads.put("/sb/v4/campaigns", CT.sbCampaign, "campaigns", "campaignId", [{ campaignId: cid, state }]);
      const e = put.get(cid) ?? { ok: false, detail: "keine Antwort" };
      const logErr = await spur([{ aktion: "sb_kampagne_zustand", objekt_art: "sb_campaign", objekt_id: cid, campaign_id: cid, vorher: { state: c.state }, nachher: { state }, ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : JSON.stringify(e.detail).slice(0, 1000) }]);
      return json({ campaignId: cid, name: c.name, vorher: c.state, nachher: state, ergebnis: e.ok ? "ok" : "fehler", detail: e.ok ? null : e.detail, ...(logErr ? { log_fehler: logErr } : {}) });
    }

    // Sponsored Brands: Negatives einer Kampagne lesen
    if (action === "sb_negatives") {
      const cid = str(body.campaignId);
      if (!cid) return json({ error: "campaignId fehlt." }, 400);
      const r = await ads.get(`/sb/negativeKeywords?campaignIdFilter=${encodeURIComponent(cid)}`);
      if (!r.ok) return json({ error: "SB-Negatives laden fehlgeschlagen", detail: r.detail }, 502);
      const list = Array.isArray(r.data) ? r.data : [];
      return json({ tenant_id: tenantId, negatives: list.map((k: any) => ({ keywordId: String(k.keywordId), campaignId: String(k.campaignId), adGroupId: String(k.adGroupId), text: k.keywordText, matchType: k.matchType, state: k.state })) });
    }

    // Sponsored Brands: Negatives anlegen {campaignId, keywords:[{text, matchType}]}
    if (action === "sb_negatives_anlegen") {
      if (!bestaetigt()) return json({ error: "bestaetigung=true fehlt. Es wurde NICHTS geschrieben." }, 400);
      const cid = str(body.campaignId);
      const kws = (Array.isArray(body.keywords) ? body.keywords : []).map((k: any) => ({ text: str(k?.text), matchType: str(k?.matchType) ?? "negativeExact" })).filter((k: any) => k.text);
      if (!cid || !kws.length) return json({ error: "campaignId und keywords nötig." }, 400);
      const ag = await ads.alle("/sb/v4/adGroups/list", CT.sbAdGroup, { campaignIdFilter: { include: [cid] } }, "adGroups");
      if (!ag.ok || !ag.daten.length) return json({ error: "SB-Anzeigengruppe nicht gefunden", detail: ag.ok ? null : ag.detail }, 404);
      const agId = String(ag.daten[0].adGroupId);
      const vorhanden = await ads.get(`/sb/negativeKeywords?campaignIdFilter=${encodeURIComponent(cid)}`);
      if (!vorhanden.ok) return json({ error: "SB-Negatives prüfen fehlgeschlagen", detail: vorhanden.detail }, 502);
      const alt = new Set((Array.isArray(vorhanden.data) ? vorhanden.data : []).map((k: any) => `${String(k.keywordText).toLowerCase()}|${k.matchType}`));
      const neu = kws.filter((k: any) => !alt.has(`${k.text.toLowerCase()}|${k.matchType}`));
      const dup = kws.filter((k: any) => alt.has(`${k.text.toLowerCase()}|${k.matchType}`));
      const ergebnisse: any[] = dup.map((k: any) => ({ ...k, ergebnis: "uebersprungen", detail: "existiert schon" }));
      if (neu.length) {
        const r = await ads.postRaw("/sb/negativeKeywords", neu.map((k: any) => ({ campaignId: cid, adGroupId: agId, keywordText: k.text, matchType: k.matchType })));
        if (!r.ok) { for (const k of neu) ergebnisse.push({ ...k, ergebnis: "fehler", detail: r.detail }); }
        else {
          const arr = Array.isArray(r.data) ? r.data : [];
          neu.forEach((k: any, i: number) => {
            const a = arr[i] ?? {};
            const ok = a.code === "SUCCESS" || a.keywordId !== undefined;
            ergebnisse.push({ ...k, keywordId: a.keywordId ? String(a.keywordId) : null, ergebnis: ok ? "ok" : "fehler", detail: ok ? null : (a.description ?? a.details ?? a) });
          });
        }
      }
      const logErr = await spur(ergebnisse.map((e) => ({ aktion: "sb_negatives_anlegen", objekt_art: "sb_negative_keyword", objekt_id: e.keywordId ?? null, campaign_id: cid, nachher: { adGroupId: agId, keywordText: e.text, matchType: e.matchType }, ergebnis: e.ergebnis, detail: e.detail ? String(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 1000) : null })));
      return json({ campaignId: cid, adGroupId: agId, angelegt: ergebnisse.filter((e) => e.ergebnis === "ok").length, uebersprungen: dup.length, fehler: ergebnisse.filter((e) => e.ergebnis === "fehler").length, ergebnisse, ...(logErr ? { log_fehler: logErr } : {}) });
    }

    return json({ error: "Unbekannte action. Erlaubt: firmen, kampagnen, gebote, vorschau, pruefen, setzen, platzierung, platzierung_setzen, negatives, keyword_anlegen, negative_anlegen, sb_kampagnen, sb_kampagne_zustand, sb_negatives, sb_negatives_anlegen" }, 400);
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

// ---------------------------------------------------------------- Ads-Client

class AdsClient {
  private headers: Record<string, string>;
  constructor(clientId: string, profileId: string, accessToken: string) {
    this.headers = {
      "Amazon-Advertising-API-ClientId": clientId,
      "Amazon-Advertising-API-Scope": profileId,
      "Authorization": `Bearer ${accessToken}`,
    };
  }

  private async call(method: "POST" | "PUT", pfad: string, ct: string, body: unknown): Promise<{ ok: true; data: any } | { ok: false; detail: unknown }> {
    for (let versuch = 0; versuch < 3; versuch++) {
      const resp = await fetch(`${ADS_ENDPOINT}${pfad}`, {
        method, headers: { ...this.headers, "Content-Type": ct, "Accept": ct }, body: JSON.stringify(body),
      });
      if (resp.status === 429) { await sleep(3000 * (versuch + 1)); continue; }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return { ok: false, detail: { status: resp.status, ...(typeof data === "object" ? data : { body: data }) } };
      return { ok: true, data };
    }
    return { ok: false, detail: "429 auch nach mehreren Versuchen" };
  }

  /** GET mit JSON (ältere SB-Endpunkte wie /sb/negativeKeywords). */
  async get(pfad: string): Promise<{ ok: true; data: any } | { ok: false; detail: unknown }> {
    const resp = await fetch(`${ADS_ENDPOINT}${pfad}`, { method: "GET", headers: { ...this.headers, "Accept": "application/json" } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, detail: { status: resp.status, ...(typeof data === "object" ? data : { body: data }) } };
    return { ok: true, data };
  }

  /** POST mit application/json und Array-Body (ältere SB-Endpunkte). */
  async postRaw(pfad: string, body: unknown): Promise<{ ok: true; data: any } | { ok: false; detail: unknown }> {
    const r = await this.call("POST", pfad, "application/json", body);
    return r.ok ? { ok: true, data: r.data } : r;
  }

  /** SP-Kampagnen roh (inkl. dynamicBidding) nach IDs. */
  async kampagnenRoh(ids: string[]) {
    return this.alle("/sp/campaigns/list", CT.campaign, { campaignIdFilter: { include: ids } }, "campaigns");
  }

  /** Anzeigengruppe einer Kampagne auflösen: angegebene prüfen oder die einzige nehmen. */
  async anzeigengruppe(campaignId: string, adGroupId: string | null): Promise<{ ok: true; id: string } | { ok: false; detail: string }> {
    const ag = await this.alle("/sp/adGroups/list", CT.adGroup, { campaignIdFilter: { include: [campaignId] } }, "adGroups");
    if (!ag.ok) return { ok: false, detail: `Anzeigengruppen laden fehlgeschlagen: ${JSON.stringify(ag.detail)}` };
    const aktiv = ag.daten.filter((g: any) => g.state !== "ARCHIVED");
    if (adGroupId) {
      return aktiv.some((g: any) => String(g.adGroupId) === adGroupId) ? { ok: true, id: adGroupId } : { ok: false, detail: "adGroupId gehört nicht zu dieser Kampagne" };
    }
    if (aktiv.length === 1) return { ok: true, id: String(aktiv[0].adGroupId) };
    return { ok: false, detail: `Kampagne hat ${aktiv.length} Anzeigengruppen, bitte adGroupId angeben: ${aktiv.map((g: any) => `${g.adGroupId} (${g.name})`).join(", ")}` };
  }

  /** Generisches Anlegen (POST /sp/keywords, /sp/negativeKeywords): Ergebnis je Index. */
  async post(pfad: string, ct: string, feld: string, items: any[]): Promise<{ ok: boolean; id?: string; detail?: unknown }[]> {
    const r = await this.call("POST", pfad, ct, { [feld]: items });
    if (!r.ok) return items.map(() => ({ ok: false, detail: r.detail }));
    const erg = r.data?.[feld] ?? {};
    const out: { ok: boolean; id?: string; detail?: unknown }[] = items.map(() => ({ ok: false, detail: "keine Antwort" }));
    for (const s of erg.success ?? []) out[s.index] = { ok: true, id: String(s.keywordId ?? s.targetId ?? s.campaignId ?? "") };
    for (const e of erg.error ?? []) out[e.index] = { ok: false, detail: e.errors ?? e };
    return out;
  }

  /** Generisches Update (PUT) mit Ergebnis je ID. */
  async put(pfad: string, ct: string, feld: string, idFeld: string, items: any[]) {
    return this.setze(pfad, ct, feld, idFeld, items);
  }

  /** Alle Seiten einer /list-Abfrage einsammeln. */
  async alle(pfad: string, ct: string, body: Record<string, unknown>, feld: string): Promise<{ ok: true; daten: any[] } | { ok: false; detail: unknown }> {
    const out: any[] = [];
    let nextToken: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await this.call("POST", pfad, ct, { ...body, maxResults: SEITE, ...(nextToken ? { nextToken } : {}) });
      if (!r.ok) return r;
      out.push(...(r.data?.[feld] ?? []));
      nextToken = r.data?.nextToken || undefined;
      if (!nextToken) break;
    }
    return { ok: true, daten: out };
  }

  async kampagnen(status: string[]) {
    const r = await this.alle("/sp/campaigns/list", CT.campaign, { stateFilter: { include: status } }, "campaigns");
    if (!r.ok) return r;
    const daten = r.daten.map((c: any) => ({
      campaignId: String(c.campaignId), name: c.name, state: c.state, targetingType: c.targetingType,
      budget: c.budget?.budget ?? null, budgetType: c.budget?.budgetType ?? null,
      strategie: c.dynamicBidding?.strategy ?? null, start: c.startDate ?? null,
    })).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    return { ok: true as const, daten };
  }

  /** Keywords + Targets der Kampagnen. Keywords/Targets ohne eigenes Gebot erben
   *  das Standardgebot der Anzeigengruppe — die werden gezählt, aber nicht geändert. */
  async gebote(kampagnenIds: string[], status: string[], nur: string | null) {
    const ag = await this.alle("/sp/adGroups/list", CT.adGroup, { campaignIdFilter: { include: kampagnenIds } }, "adGroups");
    if (!ag.ok) return ag;
    const adGroups = ag.daten.map((g: any) => ({ adGroupId: String(g.adGroupId), campaignId: String(g.campaignId), name: g.name, state: g.state, defaultBid: g.defaultBid ?? null }));

    const zeilen: GebotsZeile[] = [];
    let erben = 0;
    if (nur !== "target") {
      const k = await this.alle("/sp/keywords/list", CT.keyword, { campaignIdFilter: { include: kampagnenIds }, stateFilter: { include: status } }, "keywords");
      if (!k.ok) return k;
      for (const x of k.daten) {
        if (x.bid === undefined || x.bid === null) { erben++; continue; }
        zeilen.push({ art: "keyword", id: String(x.keywordId), campaignId: String(x.campaignId), adGroupId: String(x.adGroupId), text: x.keywordText, matchType: x.matchType, state: x.state, gebot: Number(x.bid) });
      }
    }
    if (nur !== "keyword") {
      const t = await this.alle("/sp/targets/list", CT.target, { campaignIdFilter: { include: kampagnenIds }, stateFilter: { include: status } }, "targetingClauses");
      if (!t.ok) return t;
      for (const x of t.daten) {
        if (x.bid === undefined || x.bid === null) { erben++; continue; }
        zeilen.push({ art: "target", id: String(x.targetId), campaignId: String(x.campaignId), adGroupId: String(x.adGroupId), text: targetText(x.expression), matchType: x.expressionType, state: x.state, gebot: Number(x.bid) });
      }
    }
    return { ok: true as const, zeilen, erben, adGroups };
  }

  /** Aktuelle Gebote gezielt nach IDs (für die Vorher-Prüfung beim Setzen). */
  async geboteNachId(kwIds: string[], tgIds: string[]) {
    const zeilen: GebotsZeile[] = [];
    for (let i = 0; i < kwIds.length; i += SEITE) {
      const k = await this.alle("/sp/keywords/list", CT.keyword, { keywordIdFilter: { include: kwIds.slice(i, i + SEITE) } }, "keywords");
      if (!k.ok) return k;
      for (const x of k.daten) {
        zeilen.push({ art: "keyword", id: String(x.keywordId), campaignId: String(x.campaignId), adGroupId: String(x.adGroupId), text: x.keywordText, matchType: x.matchType, state: x.state, gebot: Number(x.bid) });
      }
    }
    for (let i = 0; i < tgIds.length; i += SEITE) {
      const t = await this.alle("/sp/targets/list", CT.target, { targetIdFilter: { include: tgIds.slice(i, i + SEITE) } }, "targetingClauses");
      if (!t.ok) return t;
      for (const x of t.daten) {
        zeilen.push({ art: "target", id: String(x.targetId), campaignId: String(x.campaignId), adGroupId: String(x.adGroupId), text: targetText(x.expression), matchType: x.expressionType, state: x.state, gebot: Number(x.bid) });
      }
    }
    return { ok: true as const, zeilen };
  }

  async setzeKeywords(items: Record<string, unknown>[]) {
    return this.setze("/sp/keywords", CT.keyword, "keywords", "keywordId", items);
  }
  async setzeTargets(items: Record<string, unknown>[]) {
    return this.setze("/sp/targets", CT.target, "targetingClauses", "targetId", items);
  }

  /** Blockweise PUT; Ergebnis je ID. Amazon antwortet mit success[]/error[] samt index. */
  private async setze(pfad: string, ct: string, feld: string, idFeld: string, items: any[]): Promise<Map<string, { ok: boolean; detail?: unknown }>> {
    const out = new Map<string, { ok: boolean; detail?: unknown }>();
    for (let i = 0; i < items.length; i += UPDATE_BLOCK) {
      const block = items.slice(i, i + UPDATE_BLOCK);
      const r = await this.call("PUT", pfad, ct, { [feld]: block });
      if (!r.ok) { for (const it of block) out.set(String(it[idFeld]), { ok: false, detail: r.detail }); continue; }
      const erg = r.data?.[feld] ?? {};
      for (const s of erg.success ?? []) {
        const id = s?.[idFeld] !== undefined ? String(s[idFeld]) : String(block[s.index]?.[idFeld]);
        out.set(id, { ok: true });
      }
      for (const e of erg.error ?? []) {
        const id = String(block[e.index]?.[idFeld] ?? "?");
        out.set(id, { ok: false, detail: e.errors ?? e });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- Helfer

function leseRegel(r: any): GebotsRegel {
  const o: GebotsRegel = {};
  if (r && typeof r === "object") {
    for (const k of ["prozent", "faktor", "absolut", "min", "max"] as const) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== "") o[k] = Number(r[k]);
    }
  }
  return o;
}

function liste(x: unknown, standard: string[]): string[] {
  if (Array.isArray(x)) return x.map((v) => String(v).trim()).filter(Boolean);
  if (typeof x === "string" && x.trim()) return x.split(",").map((v) => v.trim()).filter(Boolean);
  return standard;
}

async function getAccessToken(cid: string, csec: string, rt: string): Promise<string | null> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: cid, client_secret: csec });
  const resp = await fetch(LWA_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: body.toString() });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => ({}));
  return data.access_token ?? null;
}

async function readSecret(supabase: any, secretId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_secret_id: secretId });
  if (error || !data) return null;
  return data as string;
}

function str(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t === "" ? null : t;
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

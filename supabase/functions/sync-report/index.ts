// sync-report
// Verkettet die drei Stufen zu EINEM Aufruf: request → poll bis DONE → fetch.
//
// Zeitbudget: Edge Functions haben ein Wall-Clock-Limit (~150s), ein Amazon-Report
// braucht aber oft 1-5 Min. Deshalb pollt diese Function nur bis zu einem Budget
// (POLL_BUDGET_MS) und gibt danach sauber {status:"PROCESSING", report_id} zurück,
// statt ins Timeout zu laufen. Ein erneuter Aufruf MIT report_id nimmt den Faden
// wieder auf und springt direkt zum Polling/Fetch — der Report wird nicht neu
// angefordert. Happy Path (Report < ~90s fertig) = ein einziger Aufruf.
//
// Input:  { tenant_id, report_id?, report_type?, days?, include_volatile? }
//   report_id        → Wiederaufnahme eines laufenden Reports (statt neu anfordern)
//   report_type      → default GET_SALES_AND_TRAFFIC_REPORT
//   days             → Länge des Zeitraums, default 14
//   include_volatile → default false, siehe unten
//
// ZEITFENSTER (wichtig, sonst sind die Kennzahlen falsch):
// Amazons Traffic-Daten hinken ~2 Tage nach, die Bestelldaten nicht. Ein Fenster
// bis "heute" enthält deshalb Bestellungen OHNE zugehörige Sessions — die CVR
// wäre systematisch zu hoch, und salesAndTrafficByDate und ...ByAsin widersprechen
// sich (byDate bricht 2 Tage früher ab, byAsin summiert die Bestellungen trotzdem).
// Nachgewiesen am 2026-07-17: byAsin 2 Units/15.90 EUR vs. byDate 1 Unit/8.05 EUR.
// Default ist daher ein STABILES Fenster, das STABLE_LAG_DAYS Tage vor heute endet.
// include_volatile:true fragt bis heute ab und markiert den Datensatz dann als
// is_provisional=true — die Zahlen sind dann unvollständig und dürfen nicht als
// endgültig gelten.
//
// Output: { ok, status: "DONE" | "PROCESSING" | "FATAL", ... }

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  beobachteteRate,
  STANDARD_RATEN,
  wartezeitNach429,
} from "../_shared/ratelimit.ts";
import { entferneSpalten, parseTsvBytes, pruefeFlatFile } from "../_shared/tsv.ts";
import { schreibeVerlauf } from "../_shared/history.ts";
import { schreibeSnapshots } from "../_shared/snapshots.ts";
import { laufeChangeEngine } from "../_shared/changeengine.ts";

const SP_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";
const DEFAULT_REPORT_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";
const DEFAULT_DAYS = 14;

// Was je Report-Typ verschieden ist. Vorher war alles auf Sales & Traffic
// verdrahtet — dessen reportOptions an einen Orders-Report zu schicken wäre
// schlicht falsch, der kennt sie nicht.
interface ReportKonfig {
  /** "auto" = erst JSON versuchen, sonst TSV. Für noch unbekannte Typen. */
  format: "json" | "tsv" | "auto";
  reportOptions?: Record<string, string>;
  /**
   * Wie viele Tage vor heute das stabile Fenster endet.
   * NUR für Sales & Traffic relevant: dort hinkt der TRAFFIC ~2 Tage nach.
   * Orders haben keinen Traffic — dort wären 2 Tage Abzug grundloser Datenverlust.
   */
  stableLagDays: number;
  /**
   * Spalten, die schon beim Ingest verworfen werden. Personenbezogene Daten
   * (DSGVO Art. 5(1)(c), Datenminimierung): was nie gespeichert wird, braucht
   * keine Löschfrist, keine AVV-Abdeckung und kann nicht abfließen.
   */
  piiSpalten?: string[];
  /**
   * Längster erlaubter Zeitraum in Tagen. Amazon meldet eine Überschreitung
   * NICHT als Fehler, sondern liefert einen Report, dessen INHALT die Meldung
   * ist ("Date range exceeded...") — bei processingStatus DONE und HTTP 200.
   * Deshalb hier vorab abfangen, statt sich darauf zu verlassen.
   */
  maxDays: number;
  /** Schlüssel, die ein gültiger JSON-Report enthalten MUSS. */
  pflichtSchluessel?: string[];
  /**
   * Snapshot-Report OHNE Zeitraum (z.B. aktueller FBA-Bestand). Dann werden
   * dataStartTime/dataEndTime NICHT gesendet — Amazon liefert den Ist-Stand.
   * days/maxDays/stableLagDays sind dann bedeutungslos.
   */
  snapshot?: boolean;
  /**
   * Report, den AMAZON selbst erzeugt (Abrechnungsbericht). Er kann nicht
   * angefordert werden — createReport antwortet mit einem Fehler. Stattdessen
   * werden die vorhandenen aufgelistet und der jüngste abgeholt.
   */
  vorhanden?: boolean;
}

const REPORT_KONFIG: Record<string, ReportKonfig> = {
  GET_SALES_AND_TRAFFIC_REPORT: {
    format: "json",
    reportOptions: { dateGranularity: "DAY", asinGranularity: "CHILD" },
    stableLagDays: 2,
    maxDays: 90,
    pflichtSchluessel: ["reportSpecification"],
    // Enthält keine Endkundendaten — aggregiert je Tag/ASIN.
  },
  GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL: {
    format: "tsv",
    // Kennt dateGranularity/asinGranularity NICHT — bewusst keine reportOptions.
    // Kein Traffic-Nachlauf, daher kein Abzug. ABER: sehr frische Bestellungen
    // stehen ggf. noch auf "Pending" und ändern sich noch (order-status, Preise).
    stableLagDays: 0,
    // Von Amazon selbst genannt: "Report can be requested only upto 30 days".
    maxDays: 30,
    // Standortdaten der Endkunden. ship-country bleibt bewusst erhalten: es wird
    // für die Marktplatz-/Kanalzuordnung gebraucht und ist nicht personenbeziehbar.
    piiSpalten: ["ship-city", "ship-state", "ship-postal-code"],
  },
  GET_MERCHANT_LISTINGS_ALL_DATA: {
    format: "tsv",
    // Momentaufnahme aller Angebote (aktiv + inaktiv), KEIN Zeitraum.
    // Keine Endkundendaten — die eigenen Angebote des Sellers.
    snapshot: true,
    stableLagDays: 0,
    maxDays: 0,
  },
  GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE: {
    format: "tsv",
    // Merchant-Retouren nach Antragsdatum. Zeitraumbasiert, kein Traffic-Nachlauf.
    // Kein Standort-PII (anders als Orders): keine ship-*-Spalten, nur Vorgangs-IDs
    // und Produktname. maxDays 30 als sichere Annahme (wie Orders).
    stableLagDays: 0,
    maxDays: 30,
  },
  GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA: {
    format: "tsv",
    // FBA-Kundenretouren nach Retourendatum. Braucht die Rolle "Lagerbestands- und
    // Bestellungsverfolgung" (bei e-One APPROVED). customer-comments ist Freitext
    // vom Käufer -> als PII vor dem Speichern verworfen.
    stableLagDays: 0,
    maxDays: 30,
    piiSpalten: ["customer-comments"],
  },
  GET_FBA_REIMBURSEMENTS_DATA: {
    format: "tsv",
    // Was Amazon dir erstattet hat. Selten -> längeres Fenster sinnvoll. Braucht die
    // Rolle "Finanzen und Buchhaltung" (bei Vaneja vorhanden). Keine Endkundendaten.
    stableLagDays: 0,
    maxDays: 180,
  },
  GET_LEDGER_DETAIL_VIEW_DATA: {
    format: "tsv",
    // Inventar-Ledger (Bewegungen); wir filtern beim Ingest auf Adjustments
    // (Verlust/Schaden/Fund). Braucht die Rolle "Lagerbestands-/Bestellverfolgung".
    reportOptions: { aggregateByLocation: "COUNTRY" },
    stableLagDays: 0,
    maxDays: 60,
  },
  GET_LEDGER_SUMMARY_VIEW_DATA: {
    format: "tsv",
    // Taeglicher Lagerstand je SKU — die Quelle der Bestandshistorie (echte
    // Out-of-Stock-Zeitraeume mit Anfang/Ende/Dauer).
    // BEIDE reportOptions sind Pflicht: ohne sie liefert Amazon zwar HTTP 200 und
    // DONE, aber eine Datei NUR MIT KOPFZEILE (nachgewiesen 2026-08-01, Report
    // 360894020666: 21 Spalten, 0 Zeilen). aggregatedByTimePeriod=DAILY ist noetig,
    // weil MONTHLY/WEEKLY keine Tagesgenauigkeit hergibt.
    reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "DAILY" },
    stableLagDays: 0,
    maxDays: 60,
  },
  GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA: {
    format: "tsv",
    // Momentaufnahme des FBA-Bestands, KEIN Zeitraum.
    // Historie: Am 2026-07-17 antwortete Amazon fuer die e-One-App mit
    // "Unauthorized / forbidden". Das lag an DIESER App-Autorisierung, nicht am
    // Report — mit der Vaneja-App laeuft er (2026-07-30: HTTP 200, 43 Zeilen).
    snapshot: true,
    stableLagDays: 0,
    maxDays: 0,
  },
  GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA: {
    format: "tsv",
    // Gebuehrenvorschau je SKU: Amazons Groessenklasse, Masse/Gewicht und die
    // erwarteten Gebuehren. Momentaufnahme, KEIN Zeitraum.
    // Getestet 2026-07-31: HTTP 200, 59 Zeilen, 30 Spalten.
    snapshot: true,
    stableLagDays: 0,
    maxDays: 0,
  },
  GET_FBA_INVENTORY_PLANNING_DATA: {
    format: "tsv",
    // Momentaufnahme OHNE Zeitraum. Mit Zeitfenster angefordert antwortet Amazon
    // mit FATAL (beobachtet 2026-08-01 bei GET_FBA_INVENTORY_AGED_DATA).
    snapshot: true,
    stableLagDays: 0,
    maxDays: 0,
  },
  GET_FBA_STORAGE_FEE_CHARGES_DATA: {
    format: "tsv",
    // MONATLICHER Report. Ein Fenster im laufenden Monat liefert nichts und
    // Amazon storniert ihn (beobachtet 2026-07-31: CANCELLED). Abgefragt werden
    // muss ein ABGESCHLOSSENER Monat, also mit end_date auf den Monatsersten.
    stableLagDays: 0,
    maxDays: 30,
  },
  GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2: {
    format: "tsv",
    // Abrechnungsbericht: die autoritative Geldquelle. Amazon erzeugt ihn je
    // Auszahlungszeitraum selbst — deshalb auflisten statt anfordern.
    vorhanden: true,
    snapshot: true,
    stableLagDays: 0,
    maxDays: 0,
  },
};

function konfigFuer(reportType: string): ReportKonfig {
  return REPORT_KONFIG[reportType] ?? { format: "auto", stableLagDays: 0, maxDays: 30 };
}

/**
 * Ist das überhaupt ein verwertbarer Report? Muss VOR dem Speichern laufen —
 * sonst überschreibt eine Amazon-Fehlermeldung die guten Daten.
 */
function pruefePayload(payload: unknown, konfig: ReportKonfig): { ok: true } | { ok: false; grund: string } {
  const p = payload as Record<string, any>;

  if (p?.format === "tsv") return pruefeFlatFile(p as any);

  for (const s of konfig.pflichtSchluessel ?? []) {
    if (!(p && typeof p === "object" && s in p)) {
      return { ok: false, grund: `Pflichtfeld '${s}' fehlt im Report — Amazon hat vermutlich keine Daten geliefert.` };
    }
  }
  return { ok: true };
}

// Nach diesem Budget wird das Polling abgebrochen und PROCESSING zurückgegeben.
// Bewusst unter dem Edge-Function-Limit, damit der Fetch danach noch Platz hat.
const POLL_BUDGET_MS = 90_000;
const POLL_START_MS = 5_000;
const POLL_FACTOR = 1.5;
const POLL_MAX_MS = 30_000;
const MAX_RATE_LIMIT_RETRIES = 3;

// Sammelt die von Amazon gemeldeten Limits pro Operation — rein diagnostisch,
// die Limits können je Verkäufer abweichen.
// WICHTIG: pro Request, NICHT auf Modulebene. Edge Functions halten das Isolate
// zwischen Aufrufen am Leben; ein Modul-Level-Objekt würde Werte von einem
// Tenant im nächsten Aufruf eines anderen Tenants sichtbar machen.
type RateSammler = Record<string, number>;

function merkeRate(sammler: RateSammler, operation: string, resp: Response): void {
  const rate = beobachteteRate(resp.headers);
  if (rate !== null) sammler[operation] = rate;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_BUDGET_MS;
  const rl: RateSammler = {};

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id: string | undefined = body.tenant_id;
    const resumeReportId: string | undefined = body.report_id;
    const days: number = Number(body.days ?? DEFAULT_DAYS);
    const includeVolatile: boolean = body.include_volatile === true;

    // Backfill-Parameter:
    //   end_date     → explizites Fensterende (statt heute-lag), für historische Chunks
    //   history_only → NUR die Verlaufs-Tabellen schreiben, report_data/is_latest NICHT
    //                  anfassen (sonst überschriebe ein altes Fenster den aktuellen Stand)
    const endDate: string | undefined = body.end_date;
    let historyOnly: boolean = body.history_only === true;

    // Bei Wiederaufnahme sind diese beiden NICHT aus dem Body zu nehmen, sondern
    // aus dem gespeicherten Job — sonst landen die Daten unter dem falschen
    // report_type bzw. mit falschem is_provisional. Siehe Resume-Zweig unten.
    let reportType: string = body.report_type ?? DEFAULT_REPORT_TYPE;
    let isProvisional: boolean = includeVolatile;

    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    // days gegen das Limit DES TYPS prüfen, nicht pauschal. Amazon lehnt eine
    // Überschreitung nicht ab — es liefert einen "fertigen" Report, dessen Inhalt
    // die Fehlermeldung ist. Hier abfangen, bevor überhaupt angefragt wird.
    // Snapshot-Reports (kein Zeitraum) sind davon ausgenommen.
    if (!resumeReportId && !konfigFuer(reportType).snapshot) {
      const maxDays = konfigFuer(reportType).maxDays;
      if (!Number.isFinite(days) || days < 1 || days > maxDays) {
        return json({
          error: `days muss zwischen 1 und ${maxDays} liegen`,
          detail: `Für ${reportType} erlaubt Amazon maximal ${maxDays} Tage.`,
        }, 400);
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // auth_context dieses Tenants (service_role umgeht RLS → tenant_id explizit filtern)
    const { data: ctx, error: ctxErr } = await supabase
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, marketplace_id")
      .eq("tenant_id", tenant_id)
      .eq("source", "sp")
      .single();
    if (ctxErr || !ctx) {
      return json({ error: "auth_context nicht gefunden", detail: ctxErr?.message }, 404);
    }

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) {
      return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    }

    // Ein Token für den ganzen Ablauf: gültig 3600s, das Budget ist deutlich kürzer.
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    // ---- Stufe 1: anfordern ODER laufenden Report wiederaufnehmen ----
    let reportId: string;
    // Nur bei Abrechnungen gesetzt: wie viele Berichte noch fehlen. Gehoert in
    // die Antwort, damit man sieht, ob der Rueckstand abgearbeitet wird.
    let nochOffen: number | null = null;

    if (resumeReportId) {
      // Wiederaufnahme: der Report MUSS diesem Tenant gehören. Ohne diese Prüfung
      // könnte mit einer fremden report_id ein fremder Report abgeholt werden
      // (service_role umgeht RLS).
      const { data: job, error: jobErr } = await supabase
        .from("report_jobs")
        .select("amazon_report_id, status, report_type, config")
        .eq("tenant_id", tenant_id)
        .eq("source", "sp")
        .eq("amazon_report_id", resumeReportId)
        .maybeSingle();
      if (jobErr) {
        return json({ error: "Job-Lookup fehlgeschlagen", detail: jobErr.message }, 500);
      }
      if (!job) {
        return json({ error: "report_id gehört nicht zu diesem Tenant" }, 404);
      }

      // Aus dem Job übernehmen, nicht aus dem Body: der ursprüngliche Aufruf hat
      // festgelegt, welcher Typ angefordert wurde und ob das Fenster volatil war.
      reportType = job.report_type;
      isProvisional = job.config?.include_volatile === true;
      historyOnly = job.config?.history_only === true;
      reportId = resumeReportId;
    } else {
      const konfig = konfigFuer(reportType);

      // Snapshot-Reports (FBA-Bestand) haben KEINEN Zeitraum — Amazon liefert den
      // Ist-Stand. Für zeitraumbasierte Reports das stabile Fenster berechnen:
      // Ende = heute - stableLagDays (Sales & Traffic 2 wegen Traffic-Nachlauf,
      // sonst 0). include_volatile:true geht bis heute und markiert is_provisional.
      let zeitfenster: { dataStartTime: string; dataEndTime: string } | null = null;
      if (!konfig.snapshot) {
        let end: Date;
        if (endDate) {
          // Backfill: explizites, historisches Fensterende. Solche Fenster liegen
          // in der Vergangenheit und sind stabil — kein Traffic-Lag-Abzug nötig.
          end = new Date(endDate);
          if (Number.isNaN(end.getTime())) {
            return json({ error: "end_date ist kein gültiges Datum", detail: endDate }, 400);
          }
        } else {
          const lag = includeVolatile ? 0 : konfig.stableLagDays;
          end = new Date();
          if (lag > 0) end.setDate(end.getDate() - lag);
        }
        const start = new Date(end);
        start.setDate(start.getDate() - days);
        zeitfenster = { dataStartTime: start.toISOString(), dataEndTime: end.toISOString() };
      }

      if (konfig.vorhanden) {
        // Von Amazon erzeugter Report (Abrechnung): den jüngsten holen, der noch
        // FEHLT. Welche schon da sind, steht in den eigenen Jobs — die Report-ID
        // wird dort ohnehin mitgeschrieben.
        const { data: geholt } = await supabase
          .from("report_jobs")
          .select("amazon_report_id")
          .eq("tenant_id", tenant_id)
          .eq("report_type", reportType)
          .eq("status", "DONE")
          .not("amazon_report_id", "is", null);
        const bereitsGeholt = new Set<string>(
          ((geholt ?? []) as Array<{ amazon_report_id: string }>).map((r) => String(r.amazon_report_id)),
        );

        const gefunden = await findeVorhandenenReport(
          accessToken, reportType, ctx.marketplace_id, body.nach ?? null, rl, bereitsGeholt,
        );

        // Nichts Neues ist kein Fehler — frueher wurde hier taeglich derselbe
        // Bericht erneut geladen.
        if (gefunden.nichtsNeues) {
          return json({
            ok: true,
            status: "NICHTS_NEUES",
            report_type: reportType,
            hinweis: gefunden.detail,
            dauer_s: Math.round((Date.now() - startedAt) / 1000),
          });
        }
        if (!gefunden.ok) {
          return json({ error: "Kein Abrechnungsbericht verfügbar", detail: gefunden.detail }, 502);
        }
        reportId = gefunden.reportId!;
        nochOffen = gefunden.offen ?? null;
      } else {
        const requested = await requestReport(accessToken, {
          reportType,
          marketplaceIds: [ctx.marketplace_id],
          ...(zeitfenster ?? {}),
          // Nur mitschicken, wenn der Typ welche kennt.
          ...(konfig.reportOptions ? { reportOptions: konfig.reportOptions } : {}),
        }, deadline, rl);

        if (!requested.ok) {
          return json({ error: "SP-API Fehler beim Anfordern", detail: requested.detail }, 502);
        }
        reportId = requested.reportId!;
      }

      const { error: insErr } = await supabase.from("report_jobs").insert({
        tenant_id,
        source: "sp",
        report_type: reportType,
        status: "PROCESSING",
        amazon_report_id: reportId,
        config: {
          ...(konfig.snapshot ? { snapshot: true } : { days }),
          include_volatile: includeVolatile,
          history_only: historyOnly,
          ...(zeitfenster ?? {}),
        },
      });
      if (insErr) {
        return json({ error: "Job speichern fehlgeschlagen", detail: insErr.message }, 500);
      }
    }

    // ---- Stufe 2: pollen bis DONE / FATAL / Budget aufgebraucht ----
    let delay = POLL_START_MS;
    let documentId: string | null = null;

    while (true) {
      const status = await checkReport(accessToken, reportId, deadline, rl);

      if (!status.ok) {
        await markJobFatal(supabase, tenant_id, reportId, status.detail);
        return json({ error: "SP-API Fehler beim Status", detail: status.detail }, 502);
      }

      if (status.processingStatus === "DONE") {
        documentId = status.reportDocumentId ?? null;
        await supabase
          .from("report_jobs")
          .update({ status: "DONE", report_document_id: documentId })
          .eq("tenant_id", tenant_id)
          .eq("amazon_report_id", reportId);
        break;
      }

      if (status.processingStatus === "FATAL" || status.processingStatus === "CANCELLED") {
        await supabase
          .from("report_jobs")
          .update({
            status: status.processingStatus,
            error_detail: `Amazon meldet ${status.processingStatus}`,
            completed_at: new Date().toISOString(),
          })
          .eq("tenant_id", tenant_id)
          .eq("amazon_report_id", reportId);

        return json({
          ok: false,
          status: status.processingStatus,
          report_id: reportId,
          hinweis: status.processingStatus === "FATAL"
            ? "Amazon konnte den Report nicht erstellen (FATAL). Zeitraum/Berechtigungen prüfen."
            : "Report wurde storniert (CANCELLED) — meist: keine Daten im Zeitraum.",
        }, 200);
      }

      // Noch IN_QUEUE / IN_PROGRESS: passt der nächste Versuch noch ins Budget?
      if (Date.now() + delay >= deadline) {
        return json({
          ok: true,
          status: "PROCESSING",
          report_id: reportId,
          processingStatus: status.processingStatus,
          wartezeit_s: Math.round((Date.now() - startedAt) / 1000),
          hinweis:
            "Report bei Amazon noch nicht fertig. Zeitbudget dieser Function aufgebraucht — " +
            "kein Fehler. Denselben Aufruf mit report_id wiederholen, dann wird direkt " +
            "weitergepollt und abgeholt (kein neuer Report).",
        }, 200);
      }

      await sleep(delay);
      delay = Math.min(Math.round(delay * POLL_FACTOR), POLL_MAX_MS);
    }

    if (!documentId) {
      await markJobFatal(supabase, tenant_id, reportId, "DONE, aber keine reportDocumentId");
      return json({ error: "Report DONE, aber keine reportDocumentId erhalten" }, 502);
    }

    // ---- Stufe 3: Dokument holen, entpacken, parsen, speichern ----
    // Für den Dokument-Abruf etwas mehr Luft als das Poll-Budget: der Report ist
    // an dieser Stelle fertig, es wäre unnötig, ihn wegen 2s Budget liegenzulassen.
    const fetched = await fetchDocument(
      accessToken,
      documentId,
      startedAt + POLL_BUDGET_MS + 20_000,
      rl,
      konfigFuer(reportType)
    );
    if (!fetched.ok) {
      await markJobFatal(supabase, tenant_id, reportId, fetched.detail);
      return json({ error: "Download fehlgeschlagen", detail: fetched.detail }, 502);
    }

    // PLAUSIBILITÄT VOR DEM SPEICHERN — nicht danach.
    // Amazon liefert Fehler teilweise ALS Report-Inhalt aus, bei DONE und HTTP 200
    // (real: "Date range exceeded. Report can be requested only upto 30 days").
    // Ohne diese Prüfung wird die Meldung als gültiger Datensatz gespeichert und
    // verdrängt die vorherigen, guten Daten — lautlos. Wichtig ist die Reihenfolge:
    // erst prüfen, dann is_latest anfassen. Sonst steht die DB im Fehlerfall ohne
    // aktuellen Datensatz da.
    const plausi = pruefePayload(fetched.payload, konfigFuer(reportType));
    if (!plausi.ok) {
      await markJobFatal(supabase, tenant_id, reportId, plausi.grund);
      return json({
        error: "Amazon lieferte kein verwertbares Dokument",
        detail: plausi.grund,
        hinweis: "Vorhandene Daten wurden NICHT überschrieben.",
      }, 502);
    }

    const dataTimestamp = new Date().toISOString();

    // report_data (aktueller Stand) NUR im Normalbetrieb schreiben. Beim Backfill
    // (history_only) würde ein altes Fenster den aktuellen is_latest-Stand
    // überschreiben — dort zählen ausschließlich die Verlaufs-Tabellen.
    if (!historyOnly) {
      // Reihenfolge ist Pflicht: der Unique-Index one_latest_per_report erlaubt nur
      // EINE Zeile mit is_latest pro (tenant, source, report_type). Erst altes
      // is_latest zurücksetzen, dann neu einfügen — sonst kollidiert der Insert.
      const { error: updErr } = await supabase
        .from("report_data")
        .update({ is_latest: false })
        .eq("tenant_id", tenant_id)
        .eq("source", "sp")
        .eq("report_type", reportType)
        .eq("is_latest", true);
      if (updErr) {
        await markJobFatal(supabase, tenant_id, reportId, updErr.message);
        return json({ error: "is_latest zurücksetzen fehlgeschlagen", detail: updErr.message }, 500);
      }

      const { error: insErr } = await supabase.from("report_data").insert({
        tenant_id,
        source: "sp",
        report_type: reportType,
        payload: fetched.payload,
        data_timestamp: dataTimestamp,
        is_provisional: isProvisional,
        is_latest: true,
      });
      if (insErr) {
        await markJobFatal(supabase, tenant_id, reportId, insErr.message);
        return json({ error: "Speichern fehlgeschlagen", detail: insErr.message }, 500);
      }
    }

    // Verlaufs-Tabellen füllen (Tagesbetrieb UND Backfill). Report-Typen ohne
    // Historie (Listings-Snapshot) geben tabelle:null zurück — kein Fehler.
    const verlauf = await schreibeVerlauf(supabase, tenant_id, reportType, fetched.payload);
    if (verlauf.fehler) {
      // Beim Backfill ist das Verlauf-Schreiben der eigentliche Zweck — hart melden
      // statt still zu schlucken.
      await markJobFatal(supabase, tenant_id, reportId, `Verlauf: ${verlauf.fehler}`);
      return json({ error: "Verlauf-Schreiben fehlgeschlagen", detail: verlauf.fehler }, 500);
    }

    // ASIN-Snapshots + asins-Entität aus dem Listings-Report (Flight-Recorder-Boden).
    // Andere Report-Typen: no-op. Vergleichsbasis der späteren Change-Engine.
    const snapshot = await schreibeSnapshots(supabase, tenant_id, reportType, fetched.payload, {
      snapshot_ts: dataTimestamp,
      import_report_id: reportId,
      marketplace_id: ctx.marketplace_id,
    });
    if (snapshot.fehler) {
      await markJobFatal(supabase, tenant_id, reportId, `Snapshot: ${snapshot.fehler}`);
      return json({ error: "Snapshot-Schreiben fehlgeschlagen", detail: snapshot.fehler }, 500);
    }

    // Change-Engine: aus den frischen Snapshots automatisch Change Events ableiten.
    // NICHT-fatal: der Snapshot ist bereits sicher gespeichert; ein Engine-Fehler
    // ist idempotent nachholbar (Dedup) und darf den Sync nicht kippen.
    let changeEngine: { paare: number; kandidaten: number; eingefuegt: number; fehler?: string } | null = null;
    if (snapshot.tabelle === "asin_snapshots") {
      changeEngine = await laufeChangeEngine(supabase, tenant_id, dataTimestamp.slice(0, 10));
    }

    await supabase
      .from("report_jobs")
      .update({
        status: "DONE",
        report_document_id: documentId,
        data_timestamp: dataTimestamp,
        completed_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenant_id)
      .eq("amazon_report_id", reportId);

    const p = fetched.payload as Record<string, any>;
    const keys = typeof p === "object" && p !== null ? Object.keys(p) : [];

    // Sales & Traffic (JSON) meldet den tatsächlich gelieferten Zeitraum in
    // reportSpecification zurück — Amazon kürzt das Fenster ggf. selbst, das soll
    // sichtbar sein. TSV-Reports haben das nicht; dort steht der angefragte Zeitraum
    // im report_jobs.config.
    const spec = p?.reportSpecification ?? {};

    return json({
      ok: true,
      status: "DONE",
      report_id: reportId,
      report_type: reportType,
      // Bei Abrechnungen: wie viele Berichte danach noch fehlen. Steht > 0, holt
      // der naechste Lauf den naechsten — so werden Lueckstaende abgearbeitet.
      ...(nochOffen !== null ? { abrechnungen_offen: Math.max(0, nochOffen - 1) } : {}),
      dauer_s: Math.round((Date.now() - startedAt) / 1000),
      compression: fetched.compression,
      datenstruktur_schluessel: keys,
      wiederaufgenommen: Boolean(resumeReportId),
      is_provisional: isProvisional,
      history_only: historyOnly,
      verlauf: { tabelle: verlauf.tabelle, zeilen: verlauf.zeilen },
      snapshot: { asins: snapshot.asins, snapshots: snapshot.snapshots },
      change_engine: changeEngine,
      zeitraum: { von: spec.dataStartTime ?? null, bis: spec.dataEndTime ?? null },
      // Nur bei Flat-File-Reports gefüllt:
      ...(p?.format === "tsv"
        ? {
            tsv: {
              zeilen: p.rowCount,
              zeichensatz: p.encoding,
              spalten: p.header?.length ?? 0,
              spalten_namen: p.header ?? [], // für Diagnose (echte, ggf. lokalisierte Header)
              // Sichtbar machen, dass gefiltert wurde — nicht stillschweigend.
              entfernte_pii_spalten: p.entfernteSpalten ?? [],
            },
          }
        : {}),
      // Von Amazon gemeldete Limits (Requests/Sekunde) für DIESEN Verkäufer.
      rate_limits_beobachtet: rl,
      hinweis: resumeReportId
        ? "Laufenden Report wiederaufgenommen: abgeholt und gespeichert (kein neuer Report angefordert)."
        : "Kompletter Ablauf in einem Aufruf: angefordert, gewartet, abgeholt, gespeichert.",
      ...(isProvisional
        ? { warnung: "include_volatile:true — die letzten ~2 Tage sind unvollständig (Bestellungen ohne Traffic). Kennzahlen daraus sind vorläufig." }
        : {}),
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

/**
 * Von Amazon erzeugte Reports auflisten und den passenden auswählen.
 * Nur für Typen mit `vorhanden: true` (Abrechnungsbericht) — die lassen sich
 * nicht anfordern.
 *
 * WARUM NICHT EINFACH DER JÜNGSTE (bis 2026-08-19 so): Amazon listet bis zu 100
 * verfügbare Abrechnungen, geholt wurde aber nur `fertige[0]`. Zwischen zwei
 * Auszahlungen liegen ~14 Tage — der tägliche Lauf holte also zwei Wochen lang
 * denselben Bericht, während jede Abrechnung, die zwischen zwei Läufen abgelöst
 * wurde, NIE geholt wurde. Bei Vaneja fehlten dadurch 07.05.-05.06. und
 * 19.06.-14.07. komplett: die Berichte lagen bei Amazon bereit, sie wurden nur
 * nicht abgerufen.
 *
 * Jetzt gewinnt der jüngste Bericht, der noch NICHT geholt wurde. Damit ist ein
 * neuer sofort da, und an Tagen ohne neuen arbeitet der Lauf die Lücken
 * rückwärts ab — statt zum vierzehnten Mal dieselbe Datei zu laden.
 *
 * `nach` (YYYY-MM-DD) grenzt zusätzlich auf Berichte ein, deren Datenende nicht
 * nach diesem Tag liegt (gezielter Backfill).
 */
async function findeVorhandenenReport(
  accessToken: string,
  reportType: string,
  marketplaceId: string,
  nach: string | null,
  rl: RateSammler,
  bereitsGeholt: Set<string> = new Set(),
): Promise<{ ok: boolean; reportId?: string; detail?: unknown; nichtsNeues?: boolean; offen?: number }> {
  const url = new URL(`${SP_ENDPOINT}/reports/2021-06-30/reports`);
  url.searchParams.set("reportTypes", reportType);
  url.searchParams.set("marketplaceIds", marketplaceId);
  url.searchParams.set("pageSize", "100");
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-amz-access-token": accessToken },
  });
  merkeRate(rl, "getReports", resp);
  const data = await resp.json();
  if (!resp.ok) return { ok: false, detail: data };

  const fertige = (data?.reports ?? [])
    .filter((r: any) => r?.processingStatus === "DONE" && r?.reportDocumentId)
    .sort((a: any, b: any) => String(b.dataEndTime ?? "").localeCompare(String(a.dataEndTime ?? "")));

  if (fertige.length === 0) {
    return {
      ok: false,
      detail: "Amazon führt keinen fertigen Abrechnungsbericht — er entsteht erst mit der nächsten Auszahlung.",
    };
  }
  const inFrage = nach
    ? fertige.filter((r: any) => String(r.dataEndTime ?? "").slice(0, 10) <= nach)
    : fertige;
  if (inFrage.length === 0) {
    return { ok: false, detail: `Kein Abrechnungsbericht mit Ende bis ${nach}` };
  }

  // fertige ist absteigend nach dataEndTime sortiert -> der erste ungeholte ist
  // der juengste, der noch fehlt.
  const offen = inFrage.filter((r: any) => !bereitsGeholt.has(String(r.reportId)));
  if (offen.length === 0) {
    // Kein Fehler: Es gibt schlicht nichts Neues. Frueher wurde hier taeglich
    // derselbe Bericht erneut geladen.
    return {
      ok: false,
      nichtsNeues: true,
      offen: 0,
      detail: `Alle ${inFrage.length} verfuegbaren Abrechnungsberichte sind bereits geholt.`,
    };
  }

  return { ok: true, reportId: String(offen[0].reportId), offen: offen.length };
}

// --- Stufe 1: Report anfordern (429 nach Amazons eigenem Limit behandeln) ---
async function requestReport(
  accessToken: string,
  reportBody: Record<string, unknown>,
  deadline: number,
  rl: RateSammler
): Promise<{ ok: boolean; reportId?: string; detail?: unknown }> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports`, {
      method: "POST",
      headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(reportBody),
    });
    merkeRate(rl, "createReport", resp);

    if (resp.status === 429) {
      const warte = wartezeitNach429(resp.headers, STANDARD_RATEN.createReport);
      if (Date.now() + warte >= deadline) {
        return {
          ok: false,
          detail: `Rate-Limit (429): Amazon verlangt ${Math.round(warte / 1000)}s Wartezeit, Zeitbudget reicht nicht.`,
        };
      }
      await sleep(warte);
      continue;
    }

    const data = await resp.json();
    if (!resp.ok) return { ok: false, detail: data };
    return { ok: true, reportId: data.reportId };
  }
  return { ok: false, detail: "Rate-Limit (429) auch nach mehreren Versuchen" };
}

// --- Stufe 2: Status abfragen (mit 429-Behandlung) ---
async function checkReport(
  accessToken: string,
  reportId: string,
  deadline: number,
  rl: RateSammler
): Promise<{ ok: boolean; processingStatus?: string; reportDocumentId?: string; detail?: unknown }> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
      method: "GET",
      headers: { "x-amz-access-token": accessToken },
    });
    merkeRate(rl, "getReport", resp);

    if (resp.status === 429) {
      const warte = wartezeitNach429(resp.headers, STANDARD_RATEN.getReport);
      if (Date.now() + warte >= deadline) {
        // Kein Fehler: der Aufrufer kann mit report_id wieder aufnehmen.
        return { ok: true, processingStatus: "IN_PROGRESS" };
      }
      await sleep(warte);
      continue;
    }

    const data = await resp.json();
    if (!resp.ok) return { ok: false, detail: data };
    return {
      ok: true,
      processingStatus: data.processingStatus,
      reportDocumentId: data.reportDocumentId ?? undefined,
    };
  }
  return { ok: true, processingStatus: "IN_PROGRESS" };
}

// --- Stufe 3: Dokument-URL holen, laden, entpacken, parsen ---
// getReportDocument hat eines der strengsten Limits (~1 Request pro 60s),
// deshalb braucht auch dieser Schritt eine 429-Behandlung.
async function fetchDocument(
  accessToken: string,
  documentId: string,
  deadline: number,
  rl: RateSammler,
  konfig: ReportKonfig
): Promise<{ ok: boolean; payload?: unknown; compression?: string | null; detail?: unknown }> {
  let docResp: Response | null = null;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
      method: "GET",
      headers: { "x-amz-access-token": accessToken },
    });
    merkeRate(rl, "getReportDocument", resp);

    if (resp.status === 429) {
      const warte = wartezeitNach429(resp.headers, STANDARD_RATEN.getReportDocument);
      if (Date.now() + warte >= deadline) {
        return {
          ok: false,
          detail: `Rate-Limit (429) beim Dokument-Abruf: Amazon verlangt ${Math.round(warte / 1000)}s, Zeitbudget reicht nicht. Report ist fertig — erneut mit report_id aufrufen.`,
        };
      }
      await sleep(warte);
      continue;
    }
    docResp = resp;
    break;
  }

  if (!docResp) return { ok: false, detail: "Rate-Limit (429) auch nach mehreren Versuchen" };

  const docData = await docResp.json();
  if (!docResp.ok) return { ok: false, detail: docData };

  const compression = docData.compressionAlgorithm ?? null;
  const fileResp = await fetch(docData.url);
  if (!fileResp.ok) return { ok: false, detail: `Datei-Download HTTP ${fileResp.status}` };

  // BEWUSST Bytes, nicht .text(): .text() dekodiert hart als UTF-8 und macht aus
  // Amazons Windows-1252-Flat-Files unwiederbringlich Ersatzzeichen. Welcher
  // Zeichensatz es ist, entscheidet erst der Parser (siehe _shared/tsv.ts).
  let bytes: Uint8Array;
  if (compression === "GZIP") {
    const buf = new Uint8Array(await fileResp.arrayBuffer());
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    bytes = new Uint8Array(await fileResp.arrayBuffer());
  }

  const payload = zuPayload(bytes, konfig);
  return { ok: true, payload, compression };
}

/** Bytes → payload, je nach Report-Typ. Filtert PII-Spalten VOR dem Speichern. */
function zuPayload(bytes: Uint8Array, konfig: ReportKonfig): unknown {
  const pii = konfig.piiSpalten ?? [];

  if (konfig.format === "tsv") return entferneSpalten(parseTsvBytes(bytes), pii);

  // JSON ist per Definition UTF-8.
  const text = new TextDecoder("utf-8").decode(bytes);

  if (konfig.format === "json") return JSON.parse(text);

  // "auto": unbekannter Typ — erst JSON, sonst TSV.
  try {
    return JSON.parse(text);
  } catch {
    return entferneSpalten(parseTsvBytes(bytes), pii);
  }
}

async function markJobFatal(
  supabase: any,
  tenant_id: string,
  reportId: string,
  detail: unknown
): Promise<void> {
  await supabase
    .from("report_jobs")
    .update({
      status: "FATAL",
      error_detail: String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 2000),
      completed_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenant_id)
    .eq("amazon_report_id", reportId);
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// get-sales-overview
// Liest den zuletzt gespeicherten Sales-&-Traffic-Report eines Tenants aus
// report_data und gibt die deterministisch gerechneten Kennzahlen zurück.
//
// Rechnet NICHT selbst — die Logik liegt in _shared/metrics.ts und ist dort
// unit-getestet. Diese Function macht nur I/O: lesen, rechnen lassen, ausgeben.
//
// Bewusst wird bei jedem Aufruf frisch aus dem Payload gerechnet statt Kennzahlen
// zu speichern: so können die Zahlen nie veralten oder von report_data abweichen.
//
// Input:  { tenant_id, report_type? }
// Output: Overview (siehe _shared/metrics.ts) inkl. data_timestamp + is_provisional

import { createClient } from "jsr:@supabase/supabase-js@2";
import { baueOverview } from "../_shared/metrics.ts";

const DEFAULT_REPORT_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id: string | undefined = body.tenant_id;
    const reportType: string = body.report_type ?? DEFAULT_REPORT_TYPE;

    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // service_role umgeht RLS → tenant_id explizit filtern.
    const { data: row, error } = await supabase
      .from("report_data")
      .select("payload, data_timestamp, is_provisional")
      .eq("tenant_id", tenant_id)
      .eq("source", "sp")
      .eq("report_type", reportType)
      .eq("is_latest", true)
      .maybeSingle();

    if (error) return json({ error: "Lesen fehlgeschlagen", detail: error.message }, 500);
    if (!row) {
      return json({
        error: "Keine Daten vorhanden",
        hinweis: `Für report_type '${reportType}' liegt nichts in report_data. Zuerst sync-report aufrufen.`,
      }, 404);
    }

    let overview;
    try {
      overview = baueOverview(row.payload, row.data_timestamp, row.is_provisional);
    } catch (e) {
      // z.B. uneinheitliche Währungen — lieber ehrlich scheitern als falsch rechnen.
      return json({ error: "Aufbereitung nicht möglich", detail: String(e) }, 422);
    }

    return json({
      ok: true,
      report_type: reportType,
      ...overview,
      ...(overview.is_provisional
        ? { warnung: "Datensatz ist vorläufig (include_volatile): die letzten ~2 Tage enthalten Bestellungen ohne Traffic. CVR daraus ist verzerrt." }
        : {}),
      ...(overview.konsistenz.ok
        ? {}
        : { warnung_konsistenz: "byDate und byAsin widersprechen sich. Bei einem stabilen Fenster darf das nicht vorkommen — Zahlen vor Verwendung prüfen." }),
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// get-orders-overview
// Liest den zuletzt gespeicherten Orders-Report eines Tenants aus report_data
// und gibt die deterministisch gerechneten Kennzahlen zurück.
//
// Rechnet NICHT selbst — die Logik liegt in _shared/orders.ts und ist dort
// unit-getestet. Diese Function macht nur I/O.
//
// Bewusst NICHT dieselbe Function wie get-sales-overview: die beiden Reports
// haben verschiedene Zuschnitte (Kanäle!) und verschiedene Fallstricke. Ein
// gemeinsamer Endpunkt würde nahelegen, dass man die Zahlen vergleichen darf.
//
// Input:  { tenant_id }
// Output: OrdersOverview (siehe _shared/orders.ts)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { baueOrdersOverview } from "../_shared/orders.ts";

const REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id: string | undefined = body.tenant_id;
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
      .eq("report_type", REPORT_TYPE)
      .eq("is_latest", true)
      .maybeSingle();

    if (error) return json({ error: "Lesen fehlgeschlagen", detail: error.message }, 500);
    if (!row) {
      return json({
        error: "Keine Daten vorhanden",
        hinweis: `Zuerst sync-report mit report_type '${REPORT_TYPE}' aufrufen.`,
      }, 404);
    }

    let overview;
    try {
      overview = baueOrdersOverview(row.payload, row.data_timestamp, row.is_provisional);
    } catch (e) {
      // z.B. gemischte Währungen — lieber ehrlich scheitern als falsch rechnen.
      return json({ error: "Aufbereitung nicht möglich", detail: String(e) }, 422);
    }

    return json({ ok: true, report_type: REPORT_TYPE, ...overview });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

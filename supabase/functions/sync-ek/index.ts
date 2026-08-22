// sync-ek — holt die Einkaufspreise aus dem hinterlegten Sellerboard-Export-Link
// und schreibt sie nach asin_ek.
//
// Warum eine eigene Function und nicht `api`: Der Import gab es bisher nur als
// Aktion `ek_import_url` in `api`, und die authentifiziert per Session-JWT eines
// eingeloggten Nutzers. Ein Cron hat keine Session. Deshalb hier derselbe
// Aufrufweg wie bei den anderen Syncs: POST { tenant_id } mit service_role-Bearer
// (verify_jwt = true).
//
// Die Logik selbst wird NICHT kopiert — es ist exakt dieselbe Funktion, die auch
// der Knopf im Frontend auslöst. Sonst laufen Hand- und Nachtlauf auseinander.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { importiereEkVonUrl } from "../_shared/sellerboard_import.ts";

Deno.serve(async (req) => {
  try {
    const { tenant_id, schreiben } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    // `schreiben` ist absichtlich opt-out und nicht opt-in: Ein Cron, der nur
    // eine Vorschau zieht, sähe erfolgreich aus und änderte nichts.
    const schreibt = schreiben !== false;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const erg = await importiereEkVonUrl(supabase, String(tenant_id), schreibt);
    return json({ ok: true, tenant_id, ...erg });
  } catch (e) {
    // Der Fehlertext ist bereits in tenant_einstellungen.sellerboard_ek_status
    // vermerkt (macht importiereEkVonUrl selbst) — die Wache liest ihn dort.
    return json({ error: "EK-Import fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 502);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

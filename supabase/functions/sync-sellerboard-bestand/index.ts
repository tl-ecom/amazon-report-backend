// sync-sellerboard-bestand — holt den Bestands-Feed aus dem hinterlegten
// Sellerboard-Link und schreibt ihn nach bestand_extern.
//
// Warum eine eigene Function und nicht `api`: `api` authentifiziert per
// Session-JWT eines eingeloggten Nutzers, ein Cron hat keine Session. Deshalb
// derselbe Aufrufweg wie bei sync-ek: POST { tenant_id } mit service_role-
// Bearer (verify_jwt = true).
//
// Die Logik wird NICHT kopiert — es ist exakt dieselbe Funktion, die auch der
// Knopf „Jetzt synchronisieren" ausloest. Sonst laufen Hand- und Cron-Lauf
// auseinander.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { syncSellerboardBestand } from "../_shared/sellerboard_bestand_import.ts";

Deno.serve(async (req) => {
  try {
    const { tenant_id } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const erg = await syncSellerboardBestand(supabase, String(tenant_id));
    return json({ ok: true, tenant_id, ...erg });
  } catch (e) {
    // Der Fehlertext steht bereits in bestand_verbindungen.letzter_fehler
    // (macht syncSellerboardBestand selbst) — die Wache liest ihn dort.
    return json({ error: "Bestand-Sync fehlgeschlagen", detail: String((e as Error)?.message ?? e) }, 502);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

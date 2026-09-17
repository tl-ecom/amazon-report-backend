// ads-vorschlag — eigene Gebotsautomatik, Stufe 1: rechnen und vorschlagen.
//
// SCHREIBT NICHTS NACH AMAZON. Das Ergebnis landet in ads_gebot_vorschlaege;
// angewendet wird es getrennt und nur nach Freigabe ueber die Function
// ads-gebote. Diese Trennung ist Absicht: eine Automatik, die rechnet UND
// schreibt, kann man nicht eine Woche lang gefahrlos beobachten.
//
// Die Rechenregeln liegen rein und getestet in _shared/gebotsautomatik.ts,
// die DB-Schicht in _shared/gebotsautomatik_lauf.ts.
//
// Aufruf mit Service-Role, Body {tenant_id, campaign_id?, trocken?}.
//   campaign_id  nur diese eine Kampagne statt aller aktiven Regeln
//   trocken      true = rechnen, aber auch die Vorschlaege nicht speichern
//
// Woechentlich per Cron, nicht taeglich: nach einer Gebotsaenderung braucht
// Amazon Tage, bis sich die Auslieferung einpendelt. Taegliches Nachregeln
// misst das eigene Einschwingen und dreht sich im Kreis.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { rechneKampagne, speichere } from "../_shared/gebotsautomatik_lauf.ts";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id = String((body as any)?.tenant_id ?? "").trim();
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);
    const nurKampagne = String((body as any)?.campaign_id ?? "").trim();
    const trocken = (body as any)?.trocken === true;

    let q = supabase.from("ads_gebotsregeln").select("*")
      .eq("tenant_id", tenant_id).eq("aktiv", true);
    if (nurKampagne) q = q.eq("campaign_id", nurKampagne);
    const { data: regeln, error } = await q;
    if (error) return json({ error: "Regeln nicht lesbar", detail: error.message }, 500);
    if (!regeln || regeln.length === 0) {
      return json({
        ok: true, tenant_id, laeufe: [],
        meldung: "Keine aktive Regel in ads_gebotsregeln. Ohne Regel rechnet die Automatik nichts — das ist kein Fehler, sondern der Auslieferungszustand.",
      });
    }

    const laufAm = new Date().toISOString();
    const laeufe = [];
    for (const regel of regeln) {
      try {
        const e = await rechneKampagne(supabase, tenant_id, regel);
        if (!trocken) await speichere(supabase, tenant_id, laufAm, e.vorschlaege);
        laeufe.push({
          campaign_id: e.campaign_id,
          regel: e.regel,
          aufschlag_gewichtet: e.aufschlag_gewichtet,
          bilanz: e.bilanz,
          // Die groessten Senkungen zuerst — das ist, was man zuerst sehen will.
          top: e.vorschlaege
            .filter((v) => v.gebot_neu !== null)
            .sort((a, b) =>
              ((a.gebot_neu! - a.gebot_alt!) - (b.gebot_neu! - b.gebot_alt!))
            )
            .slice(0, 15)
            .map((v) => ({
              text: v.text, match_type: v.match_type, ziel_id: v.ziel_id,
              gebot_alt: v.gebot_alt, gebot_neu: v.gebot_neu,
              klicks: v.klicks, bestellungen: v.bestellungen,
              belastbar: v.belastbar, begruendung: v.begruendung,
            })),
        });
      } catch (e) {
        laeufe.push({ campaign_id: String(regel.campaign_id), fehler: String(e) });
      }
    }

    return json({
      ok: true, tenant_id, lauf_am: laufAm, trocken, laeufe,
      hinweis: "Stufe 1: nichts davon wurde nach Amazon geschrieben. Anwenden ueber tools/ads_gebote.py bzw. die Function ads-gebote.",
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

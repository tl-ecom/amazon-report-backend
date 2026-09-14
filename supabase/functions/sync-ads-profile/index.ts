// sync-ads-profile — welche Werbe-Profile sieht der hinterlegte Token?
//
// Pulse holt Ads-Daten heute gegen GENAU EIN Profil: das, was beim Verbinden zum
// Marktplatz der SP-Verbindung passte — bei allen Mandanten Deutschland. Ein
// Ads-Profil gilt aber je Marktplatz. Frankreich fehlt deshalb nicht, weil dort
// nichts laeuft, sondern weil nie jemand danach gefragt hat.
//
// Diese Funktion fragt. Sie schreibt nur in `ads_profile` und aendert an den
// Daten selbst nichts: ein neu entdecktes Profil kommt mit `aktiv = false` an.
// Von allein Daten zu ziehen wuerde API-Kontingent kosten und Zahlen bewegen,
// die jemand gerade liest.
//
// Aufruf mit Service-Role (ueber die RPC `ads_profile_holen`), Body {tenant_id}.

import { createClient } from "jsr:@supabase/supabase-js@2";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const ADS_ENDPOINT = "https://advertising-api-eu.amazon.com";

/**
 * Laendercode zu Marketplace-ID. Dieselbe Kennung wie in SP-API und SQP, damit
 * die drei Quellen ueber denselben Schluessel zusammenfinden.
 */
const MARKTPLATZ: Record<string, string> = {
  DE: "A1PA6795UKMFR9",
  FR: "A13V1IB3VIYZZH",
  IT: "APJ6JRA9NG5V4",
  ES: "A1RKKUPIHCS9HS",
  NL: "A1805IZSGTT6HS",
  UK: "A1F83G8C2ARO7P",
  GB: "A1F83G8C2ARO7P",
  BE: "AMEN7PMS3EDWL",
  PL: "A1C3SOZRARQ6R3",
  SE: "A2NODRKZP88ZB9",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function readSecret(supabase: any, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.rpc("read_vault_secret", { p_secret_id: id });
  return (data as string) ?? null;
}

async function getAccessToken(
  clientId: string, clientSecret: string, refreshToken: string,
): Promise<string | null> {
  const resp = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  return resp.ok ? ((data as any).access_token ?? null) : null;
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id = String(body?.tenant_id ?? "").trim();
    if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

    const { data: ctx } = await supabase.from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret, profile_id")
      .eq("tenant_id", tenant_id).eq("source", "ads").maybeSingle();
    if (!ctx) return json({ error: "Kein ads-auth_context für diesen Tenant" }, 404);

    const clientId = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);
    if (!clientId || !clientSecret || !refreshToken) {
      return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    }

    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    if (!accessToken) return json({ error: "Access-Token fehlgeschlagen" }, 502);

    const resp = await fetch(`${ADS_ENDPOINT}/v2/profiles`, {
      headers: {
        "Amazon-Advertising-API-ClientId": clientId,
        "Authorization": `Bearer ${accessToken}`,
      },
    });
    const daten = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json({ error: "profiles-Abruf fehlgeschlagen", status: resp.status, detail: daten }, 502);
    }
    const liste = Array.isArray(daten) ? daten : [];

    const jetzt = new Date().toISOString();
    const zeilen = liste.map((p: any) => {
      const land = String(p?.countryCode ?? "").toUpperCase();
      return {
        tenant_id,
        profile_id: String(p?.profileId ?? ""),
        country_code: land || null,
        waehrung: p?.currencyCode ?? null,
        zeitzone: p?.timezone ?? null,
        konto_name: p?.accountInfo?.name ?? null,
        konto_typ: p?.accountInfo?.type ?? null,
        marktplatz: MARKTPLATZ[land] ?? null,
        gesehen_am: jetzt,
      };
    }).filter((z) => z.profile_id);

    if (zeilen.length > 0) {
      // Bewusst OHNE `aktiv`: ein erneuter Lauf darf eine Freischaltung nicht
      // zuruecksetzen, und ein neues Profil bleibt beim Standard false.
      const { error } = await supabase.from("ads_profile")
        .upsert(zeilen, { onConflict: "tenant_id,profile_id" });
      if (error) return json({ error: "Speichern fehlgeschlagen", detail: error.message }, 500);
    }

    // Das bisher genutzte Profil ist per Definition aktiv — sonst stuende die
    // Tabelle im Widerspruch zu dem, was seit Monaten laeuft.
    if (ctx.profile_id) {
      await supabase.from("ads_profile")
        .update({ aktiv: true })
        .eq("tenant_id", tenant_id).eq("profile_id", String(ctx.profile_id));
    }

    return json({
      ok: true,
      tenant_id,
      gefunden: zeilen.length,
      bisher_genutzt: ctx.profile_id ?? null,
      profile: zeilen.map((z) => ({
        profile_id: z.profile_id, land: z.country_code,
        marktplatz: z.marktplatz, waehrung: z.waehrung,
        konto: z.konto_name, typ: z.konto_typ,
      })),
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

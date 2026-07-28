// get-access-token
// Tauscht den Refresh-Token eines Tenants gegen einen Amazon Access-Token.
// Gibt aus Sicherheitsgründen NICHT den Token selbst zurück, nur Länge + Ablauf.

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const { tenant_id } = await req.json();
    if (!tenant_id) {
      return json({ error: "tenant_id fehlt" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: ctx, error: ctxErr } = await supabase
      .from("auth_contexts")
      .select("client_id_secret, client_secret_secret, refresh_token_secret")
      .eq("tenant_id", tenant_id)
      .eq("source", "sp")
      .single();

    if (ctxErr || !ctx) {
      return json({ error: "auth_context nicht gefunden", detail: ctxErr?.message }, 404);
    }

    const clientId     = await readSecret(supabase, ctx.client_id_secret);
    const clientSecret = await readSecret(supabase, ctx.client_secret_secret);
    const refreshToken = await readSecret(supabase, ctx.refresh_token_secret);

    if (!clientId || !clientSecret || !refreshToken) {
      return json({ error: "Vault-Werte konnten nicht gelesen werden" }, 500);
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const resp = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return json({ error: "Amazon LWA Fehler", status: resp.status, detail: data }, 502);
    }

    return json({
      ok: true,
      access_token_laenge: (data.access_token ?? "").length,
      expires_in: data.expires_in,
      hinweis: "Token erfolgreich erhalten – Zugangsdaten funktionieren.",
    });
  } catch (e) {
    return json({ error: "Ausnahme", detail: String(e) }, 500);
  }
});

async function readSecret(supabase: any, secretId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("read_vault_secret", { p_secret_id: secretId });
  if (error || !data) return null;
  return data as string;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

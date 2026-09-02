// mcp-url — Adapter für MCP-Clients, die KEINEN eigenen Header setzen können.
//
// Manche MCP-Clients (z. B. der ChatGPT-Connector) bieten nur "OAuth" oder
// "keine Authentifizierung" an — aber kein Feld für einen Bearer-/API-Token.
// Dieser Adapter nimmt den Token stattdessen aus der URL-Query (?token= / ?key=)
// und leitet die Anfrage 1:1 an die echte `mcp`-Funktion weiter, wobei er den
// Token dort als `Authorization: Bearer …`-Header setzt.
//
// Die eigentliche Auth/Tenant-Isolation bleibt komplett in `mcp` — dieser Adapter
// fügt NUR den Header hinzu. verify_jwt = false, weil die Auth über den Token läuft.
//
// Sicherheitshinweis: Der Token steht bei diesem Weg in der URL (Query-String) und
// kann daher in Client-/Server-Logs auftauchen. Der Token ist an EINEN Tenant
// gebunden und jederzeit widerrufbar (public.mcp_tokens.revoked = true).

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const inUrl = new URL(req.url);
  const token = (inUrl.searchParams.get("token") ?? inUrl.searchParams.get("key") ?? "").trim();

  const ziel = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mcp`;

  // Header übernehmen, aber Host/Length von fetch neu setzen lassen und den
  // Token als Bearer ergänzen.
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  const resp = await fetch(ziel, init);
  const buf = await resp.arrayBuffer();

  // Ablaufspur: Kam ueberhaupt ein Token in der URL an?
  //
  // Anlass: Am 02.09. meldete Claude "keine Anmeldung konfiguriert, Server
  // verlangt aber eine (401)". In der Spur sahen zwei Ursachen gleich aus —
  // fehlender ?token=-Teil in der URL oder ein verstuemmelter Token. Hier steht
  // jetzt, welche es war. NUR die Laenge, nie der Token selbst.
  try {
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    client.from("oauth_ereignisse").insert({
      schritt: "mcp-url",
      ergebnis: resp.status < 400 ? "ok" : "fehler",
      grund: (token
        ? `Token in der URL (${token.length} Zeichen)`
        : "KEIN token/key in der URL") + ` | pfad=${inUrl.pathname} | status=${resp.status}`,
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 200),
    }).then(() => {}, () => {});
  } catch { /* Protokollieren darf nie stoeren */ }

  const out = new Headers();
  const ct = resp.headers.get("content-type");
  if (ct) out.set("content-type", ct);
  const wa = resp.headers.get("www-authenticate");
  if (wa) out.set("www-authenticate", wa);

  return new Response(buf, { status: resp.status, headers: out });
});

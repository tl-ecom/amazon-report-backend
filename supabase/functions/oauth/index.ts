// oauth — MCP-OAuth-2.1-Authorization-Server (Self-Serve-Connect).
//
// Schritt 1 von 4: DISCOVERY + DYNAMIC CLIENT REGISTRATION.
//   GET  …/oauth/.well-known/oauth-authorization-server  -> AS-Metadaten (RFC 8414)
//   GET  …/oauth/.well-known/oauth-protected-resource     -> Ressourcen-Metadaten (RFC 9728)
//   POST …/oauth/register                                 -> DCR (RFC 7591)
// /authorize (Schritt 2) und /token (Schritt 3) folgen — hier noch 501.
//
// verify_jwt = false: OAuth-Clients bringen keinen Supabase-JWT mit; die Auth
// dieses Servers passiert in den späteren Schritten selbst.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { baueAsMetadata, baueResourceMetadata, oauthBasis, pruefeRedirectUris } from "../_shared/oauth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const path = new URL(req.url).pathname;
  const { issuer, resource } = oauthBasis();

  // --- Discovery ---
  if (req.method === "GET" && path.endsWith("/.well-known/oauth-authorization-server")) {
    return json(baueAsMetadata(issuer));
  }
  if (req.method === "GET" && path.endsWith("/.well-known/oauth-protected-resource")) {
    return json(baueResourceMetadata(resource, issuer));
  }

  // --- Dynamic Client Registration (RFC 7591) ---
  if (req.method === "POST" && path.endsWith("/register")) {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_client_metadata", error_description: "Body ist kein JSON" }, 400);
    }
    let uris: string[];
    try {
      uris = pruefeRedirectUris(body?.redirect_uris);
    } catch (e) {
      return json({ error: "invalid_redirect_uri", error_description: String((e as Error)?.message ?? e) }, 400);
    }
    const client_id = crypto.randomUUID();
    const client_name = String(body?.client_name ?? "MCP Client").slice(0, 120);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await supabase.from("oauth_clients").insert({
      client_id, client_name, redirect_uris: uris, token_endpoint_auth_method: "none",
    });
    if (error) return json({ error: "server_error", error_description: error.message }, 500);
    return json({
      client_id,
      client_name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }, 201);
  }

  // --- Platzhalter für Schritt 2/3 ---
  if (path.endsWith("/authorize") || path.endsWith("/token")) {
    return json({ error: "temporarily_unavailable", error_description: "Endpoint folgt in Schritt 2/3" }, 501);
  }

  return json({ error: "not_found" }, 404);
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

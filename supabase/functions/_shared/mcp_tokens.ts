// mcp_tokens.ts — MCP-Zugangstokens erzeugen/auflisten/widerrufen (Connect-Tab).
//
// Sicherheit: Der Klartext-Token wird NUR bei der Erzeugung EINMAL zurückgegeben.
// Die DB speichert ausschließlich seinen SHA-256-Hash — genau so, wie die mcp-Auth
// ihn prüft (mcp/index.ts hasht den Bearer-Token und vergleicht token_hash).
// tenant_id kommt IMMER aus der authentifizierten Session, nie aus dem Body.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function zufallsToken(): string {
  const bytes = new Uint8Array(24); // 192 Bit Entropie
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `oppulse_${hex}`;
}

/**
 * Firmen-Slug für die Connector-URL. Zweck: ChatGPT identifiziert einen Connector
 * über seine URL — damit der Coach e-One UND Vaneja GLEICHZEITIG einbinden kann,
 * braucht jede Firma eine eigene URL. Der Slug ist rein zur Unterscheidung; der
 * Zugriff wird weiter allein durch Token/OAuth (Tenant-Bindung) entschieden.
 */
export function slugFuerTenant(name: string | null | undefined, tenantId: string): string {
  const basis = String(name ?? "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const suffix = tenantId.replace(/-/g, "").slice(0, 6);
  return basis ? `${basis}-${suffix}` : suffix;
}

/** Fertige Connector-URL (Token in der Query) — rein/testbar. Für Clients wie den
 *  ChatGPT-Connector, die kein eigenes Bearer-Feld haben (Adapter mcp-url). Mit
 *  optionalem Firmen-Slug im Pfad, damit ChatGPT je Firma einen eigenen Connector sieht. */
export function mcpConnectorUrl(base: string, token: string, slug?: string): string {
  const pfad = slug ? `/mcp-url/${slug}` : `/mcp-url`;
  return `${base.replace(/\/+$/, "")}/functions/v1${pfad}?token=${token}`;
}

/** Direkte MCP-URL (Token gehört in den Authorization-Header bzw. OAuth) — mit optionalem Firmen-Slug. */
export function mcpDirektUrl(base: string, slug?: string): string {
  const pfad = slug ? `/mcp/${slug}` : `/mcp`;
  return `${base.replace(/\/+$/, "")}/functions/v1${pfad}`;
}

/** Lädt den Firmennamen und baut den Slug (für die per-Firma-URLs). */
export async function tenantSlug(supabase: any, tenant_id: string): Promise<string> {
  const { data } = await supabase.from("tenants").select("name").eq("id", tenant_id).maybeSingle();
  return slugFuerTenant(data?.name ?? null, tenant_id);
}

/**
 * Erzeugt einen neuen Token für DIESEN Tenant. Optional werden vorher alle aktiven
 * Tokens widerrufen (alte_widerrufen). Gibt den Klartext-Token + fertige URLs zurück
 * — der Aufrufer zeigt sie dem Nutzer EINMALIG; danach ist nur der Hash bekannt.
 */
export async function erzeugeMcpToken(
  supabase: any,
  tenant_id: string,
  user_id: string,
  args: any,
): Promise<unknown> {
  const name = (String(args?.name ?? "").trim().slice(0, 60)) || "ChatGPT";
  // "alte_widerrufen" nur die EIGENEN — nie fremde/Coach-Token.
  if (args?.alte_widerrufen) {
    await supabase.from("mcp_tokens").update({ revoked: true })
      .eq("tenant_id", tenant_id).eq("revoked", false).eq("created_by", user_id);
  }

  const token = zufallsToken();
  const token_hash = await sha256Hex(token);
  const { data, error } = await supabase
    .from("mcp_tokens")
    .insert({ tenant_id, token_hash, name, revoked: false, created_by: user_id })
    .select("id, name, created_at")
    .maybeSingle();
  if (error) throw new Error(`Token anlegen: ${error.message}`);

  const base = oeffentlicheBasis();
  const slug = await tenantSlug(supabase, tenant_id);
  return {
    id: data?.id,
    name: data?.name,
    token, // NUR jetzt sichtbar
    connector_url: mcpConnectorUrl(base, token, slug),
    mcp_url: mcpDirektUrl(base, slug),
  };
}

/** Öffentliche Basis-URL: gebrandete Domain (MCP_PUBLIC_BASE), sonst Supabase.
 *  Der Pfad /functions/v1/… bleibt gleich → ein einziger Proxy-Rewrite genügt. */
export function oeffentlicheBasis(): string {
  return Deno.env.get("MCP_PUBLIC_BASE") ?? Deno.env.get("SUPABASE_URL") ?? "";
}

/** Listet Tokens — OHNE Klartext/Hash. Teilnehmer (nicht-Admin) sehen NUR die
 *  selbst erstellten; Coach/Admin sieht alle des Tenants (inkl. Coach-Token). */
export async function listeMcpTokens(
  supabase: any, tenant_id: string, user_id: string, isAdmin: boolean,
): Promise<unknown> {
  let q = supabase
    .from("mcp_tokens")
    .select("id, name, created_at, last_used_at, revoked, created_by")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false });
  if (!isAdmin) q = q.eq("created_by", user_id);
  const { data, error } = await q;
  if (error) throw new Error(`mcp_tokens: ${error.message}`);
  // created_by markiert Coach-Token für die UI, ohne fremde User-IDs breit zu streuen.
  const tokens = (data ?? []).map((t: any) => ({
    id: t.id, name: t.name, created_at: t.created_at, last_used_at: t.last_used_at,
    revoked: t.revoked, coach_token: isAdmin ? t.created_by !== user_id : false,
  }));
  const slug = await tenantSlug(supabase, tenant_id);
  return { tokens, mcp_url: mcpDirektUrl(oeffentlicheBasis(), slug) };
}

/** Widerruft einen Token. Teilnehmer nur EIGENE; Coach/Admin jeden des Tenants. */
export async function widerrufeMcpToken(
  supabase: any, tenant_id: string, user_id: string, isAdmin: boolean, args: any,
): Promise<unknown> {
  const id = String(args?.id ?? "").trim();
  if (!id) throw new Error("id fehlt");
  const { data: tok, error: lErr } = await supabase
    .from("mcp_tokens").select("id, created_by").eq("id", id).eq("tenant_id", tenant_id).maybeSingle();
  if (lErr) throw new Error(`Widerruf-Lookup: ${lErr.message}`);
  if (!tok) throw new Error("Token nicht gefunden.");
  if (!isAdmin && tok.created_by !== user_id) throw new Error("Nur eigene Zugänge widerrufbar.");

  const { error } = await supabase
    .from("mcp_tokens").update({ revoked: true })
    .eq("id", id).eq("tenant_id", tenant_id);
  if (error) throw new Error(`Widerruf: ${error.message}`);
  return { ok: true };
}

-- MCP-ZUGANGSTOKEN — pro Tenant, für die Authentifizierung am MCP-Server.
--
-- Modell: Der Betreiber gibt jedem Kunden einen Bearer-Token für dessen KI-Client
-- (ChatGPT/Claude). Der Token identifiziert den Tenant. Passt zu "Weg A": jeder
-- Kunde ist ohnehin getrennt.
--
-- SICHERHEIT wie bei API-Keys:
--   * In der DB liegt NUR der SHA-256-Hash, nie der Klartext-Token.
--   * Der MCP-Server (Edge Function) hasht den eingehenden Token selbst und
--     sucht den Hash — der Klartext erreicht die DB nie.
--   * Klartext existiert nur einmal bei der Erzeugung; danach nicht wieder
--     herstellbar. Verloren = neuen Token ausstellen, alten widerrufen.
--   * RLS an, KEINE Policies → anon/authenticated kommen gar nicht ran, nur
--     service_role (das umgeht RLS). Ein geleakter anon-Key nützt hier nichts.

create table if not exists public.mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  token_hash   text not null unique,             -- sha-256 hex des Bearer-Tokens
  name         text not null,                    -- z.B. "ChatGPT Kunde Müller"
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false
);

-- Nachschlag beim Auth: Hash + nicht widerrufen. Partieller Index hält ihn klein.
create index if not exists idx_mcp_tokens_lookup
  on public.mcp_tokens (token_hash)
  where not revoked;

alter table public.mcp_tokens enable row level security;
-- Bewusst KEINE Policy: damit ist die Tabelle für anon/authenticated komplett
-- gesperrt. Nur service_role (im MCP-Server) liest/schreibt hier.

-- Diagnose: zeigt die Token eines Tenants OHNE Hash/Klartext. Nur service_role.
create or replace function public.mcp_tokens_uebersicht(p_tenant_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'revoked', revoked,
    'created_at', created_at, 'last_used_at', last_used_at
  ) order by created_at), '[]'::jsonb)
  from public.mcp_tokens
  where tenant_id = p_tenant_id
$$;

revoke all on function public.mcp_tokens_uebersicht(uuid) from public, anon, authenticated;
grant execute on function public.mcp_tokens_uebersicht(uuid) to service_role;

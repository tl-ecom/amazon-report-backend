-- OAuth-2.1-Authorization-Server für den MCP-Zugang (Self-Serve). Drei Tabellen,
-- alle RLS an / keine Policies (nur service_role via Edge Functions).
-- Geheimnisse werden NIE im Klartext gespeichert: Auth-Codes und Tokens nur als
-- SHA-256-Hash (wie mcp_tokens). Der statische mcp_tokens-Weg bleibt parallel gültig.

-- Dynamisch registrierte Clients (RFC 7591). ChatGPT registriert sich selbst.
create table if not exists public.oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris jsonb not null default '[]'::jsonb,
  token_endpoint_auth_method text not null default 'none',
  created_at timestamptz not null default now()
);
alter table public.oauth_clients enable row level security;

-- Kurzlebige Authorization Codes (Auth-Code-Flow mit PKCE). Nur Hash gespeichert.
create table if not exists public.oauth_auth_codes (
  code_hash text primary key,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text,
  code_challenge_method text,
  user_id uuid not null,
  tenant_id uuid not null,
  scope text,
  resource text,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.oauth_auth_codes enable row level security;

-- Ausgegebene Access-/Refresh-Tokens. Nur Hashes; jederzeit widerrufbar.
create table if not exists public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  access_hash text unique not null,
  refresh_hash text unique,
  client_id text not null,
  user_id uuid not null,
  tenant_id uuid not null,
  scope text,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.oauth_tokens enable row level security;

create index if not exists oauth_tokens_tenant_idx on public.oauth_tokens (tenant_id) where not revoked;
create index if not exists oauth_auth_codes_expires_idx on public.oauth_auth_codes (expires_at);;

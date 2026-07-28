-- FRONTEND-AUTH — welcher eingeloggte Supabase-Auth-Nutzer gehört zu welchem Tenant.
--
-- Bisher gab es nur Server-Zugriffe (Cron/service_role) und den MCP-Bearer-Token.
-- Für ein Multi-Tenant-Web-Portal braucht es die Zuordnung Auth-User → Tenant.
-- Die RLS-Policies (current_tenant_id() aus JWT-Claim) existieren schon, setzen
-- aber einen tenant_id-Claim voraus, den niemand füllt. Statt eines Custom Access
-- Token Hooks (Extra-Konfig) leitet der Read-Endpunkt `api` den Tenant über diese
-- Tabelle ab — analog zum MCP-Server (Identität → Tenant, nie aus dem Request-Body).

create table if not exists public.tenant_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null default 'viewer' check (role in ('viewer','admin')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

alter table public.tenant_members enable row level security;

-- Ein Nutzer darf NUR die eigenen Mitgliedschaften sehen.
drop policy if exists own_memberships on public.tenant_members;
create policy own_memberships on public.tenant_members
  for select using (user_id = auth.uid());

-- Tenant des aktuell eingeloggten Nutzers. security definer + auth.uid():
-- läuft im Kontext des User-JWT, gibt dessen Tenant zurück (erster, falls je
-- mehrere). Kein Argument → nicht fälschbar von außen.
create or replace function public.my_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.tenant_members where user_id = auth.uid() limit 1
$$;

revoke all on function public.my_tenant_id() from public, anon;
grant execute on function public.my_tenant_id() to authenticated, service_role;

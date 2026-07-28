-- PHASE 1 — Schema, Indizes, RLS, Policies, Vault
-- Bereits in der Cloud ausgeführt. Hier zur Versionierung / Reproduzierbarkeit.

create extension if not exists supabase_vault with schema vault cascade;
create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active'
              check (status in ('active','paused','offboarded')),
  created_at  timestamptz not null default now()
);

create table if not exists public.auth_contexts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  source                text not null check (source in ('sp','ads')),
  region                text not null,
  marketplace_id        text,
  profile_id            text,
  client_id_secret      uuid not null,
  client_secret_secret  uuid not null,
  refresh_token_secret  uuid not null,
  status                text not null default 'connected'
                        check (status in ('connected','error','revoked')),
  connected_at          timestamptz not null default now(),
  unique (tenant_id, source)
);

create table if not exists public.report_jobs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  source              text not null check (source in ('sp','ads')),
  report_type         text not null,
  config              jsonb not null default '{}'::jsonb,
  status              text not null default 'PROCESSING'
                      check (status in ('PROCESSING','DONE','FATAL','CANCELLED')),
  amazon_report_id    text,
  report_document_id  text,
  error_detail        text,
  data_timestamp      timestamptz,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

create table if not exists public.report_data (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  source          text not null check (source in ('sp','ads')),
  report_type     text not null,
  payload         jsonb not null,
  data_timestamp  timestamptz not null,
  is_provisional  boolean not null default false,
  is_latest       boolean not null default true,
  created_at      timestamptz not null default now()
);

create index if not exists idx_report_jobs_lookup
  on public.report_jobs (tenant_id, source, report_type, status);

create unique index if not exists one_latest_per_report
  on public.report_data (tenant_id, source, report_type)
  where is_latest;

create index if not exists idx_report_data_latest
  on public.report_data (tenant_id, source, report_type)
  where is_latest;

create or replace function public.current_tenant_id()
returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id',
      ''
    ), ''
  )::uuid
$$;

alter table public.tenants        enable row level security;
alter table public.auth_contexts  enable row level security;
alter table public.report_jobs    enable row level security;
alter table public.report_data    enable row level security;

drop policy if exists own_tenant on public.tenants;
create policy own_tenant on public.tenants
  for select using (id = public.current_tenant_id());

drop policy if exists tenant_isolation_ac_select on public.auth_contexts;
create policy tenant_isolation_ac_select on public.auth_contexts
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists tenant_isolation_rj_select on public.report_jobs;
create policy tenant_isolation_rj_select on public.report_jobs
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists tenant_isolation_rd_select on public.report_data;
create policy tenant_isolation_rd_select on public.report_data
  for select using (tenant_id = public.current_tenant_id());

drop policy if exists tenant_isolation_rd_insert on public.report_data;
create policy tenant_isolation_rd_insert on public.report_data
  for insert with check (tenant_id = public.current_tenant_id());

drop policy if exists tenant_isolation_rd_update on public.report_data;
create policy tenant_isolation_rd_update on public.report_data
  for update using (tenant_id = public.current_tenant_id());

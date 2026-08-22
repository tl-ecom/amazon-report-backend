create table if not exists public.strategie_massnahme (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  asin text not null,
  befund_id uuid references public.strategie_befund(id) on delete set null,
  kennzahl text,
  text text not null,
  effekt_eur numeric not null,
  status text not null default 'offen',
  grund text,
  erledigt_am timestamptz,
  erstellt_am timestamptz not null default now(),
  erstellt_von uuid,
  constraint strategie_massnahme_status_chk check (status in ('offen','erledigt','verworfen'))
);
alter table public.strategie_massnahme enable row level security;
create index if not exists strategie_massnahme_asin_idx on public.strategie_massnahme (tenant_id, asin, status);;

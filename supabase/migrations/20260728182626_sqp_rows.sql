-- Search Query Performance (Brand Analytics) je ASIN + Suchanfrage.
create table if not exists public.sqp_rows (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  asin         text not null,
  search_query text not null,
  volume       bigint not null default 0,
  eigene_ctr   numeric, markt_ctr numeric, ctr_index numeric,
  eigene_cvr   numeric, markt_cvr numeric, cvr_index numeric,
  kaufanteil   numeric,
  duenn        boolean not null default false,
  zeitraum_von date, zeitraum_bis date,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, asin, search_query)
);
create index if not exists sqp_rows_tenant_asin_idx on public.sqp_rows (tenant_id, asin, volume desc);
alter table public.sqp_rows enable row level security;;

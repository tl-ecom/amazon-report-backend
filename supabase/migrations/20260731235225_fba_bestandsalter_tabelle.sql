-- Bestandsalter je SKU (GET_FBA_INVENTORY_PLANNING_DATA).
--
-- Grundlage für die Coaching-Regel: Lagergebühr für die ersten drei Monate ist
-- der Preis des Verkaufens; ab dem vierten Monat ist sie selbst erzeugt, weil
-- der Bestand zu lange liegt.
--
-- Amazons Altersstufen passen genau auf dieses Raster: 0–30, 31–60, 61–90 sind
-- die ersten drei Monate, alles ab 91 Tagen ist danach.
create table if not exists public.fba_bestandsalter (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sku text not null,
  asin text,
  fnsku text,
  produktname text,
  verfuegbar numeric,
  -- Monate 1 bis 3
  alter_0_30 numeric,
  alter_31_60 numeric,
  alter_61_90 numeric,
  -- ab Monat 4
  alter_91_180 numeric,
  alter_181_270 numeric,
  alter_271_365 numeric,
  alter_365_plus numeric,
  -- Von Amazon geschätzte Langzeitlagergebühren, falls mitgeliefert
  ltsf_6m_cents bigint,
  ltsf_12m_cents bigint,
  stand timestamptz not null default now(),
  raw jsonb,
  primary key (tenant_id, sku)
);
alter table public.fba_bestandsalter enable row level security;
create index if not exists fba_bestandsalter_asin_idx
  on public.fba_bestandsalter (tenant_id, asin);

comment on table public.fba_bestandsalter is
  'Bestandsalter je SKU. Trennt die ersten drei Monate (Preis des Verkaufens) von allem ab Monat 4 (zu lange gelegen).';;

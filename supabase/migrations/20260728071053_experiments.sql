-- Experimente: entstehen aus einem als "geplanter Test" bestätigten Change Event
-- (oder später eigenständig). Vorher/Nachher-Auswertung wird beim Lesen aus der
-- vorhandenen Historie gerechnet — ehrlich, ohne Kausalitätsbehauptung.

create table public.experiments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  asin               text,
  seller_sku         text,
  change_event_id    uuid references public.change_events(id) on delete set null,
  experiment_type    text not null default 'change_test',
  hypothesis         text,
  target_metric      text,
  start_value        text,
  target_value       text,
  start_date         date not null,
  review_7           date,
  review_14          date,
  review_30          date,
  status             text not null default 'aktiv',  -- aktiv|wartet_auf_daten|abgeschlossen|abgebrochen|verworfen
  responsible_user_id uuid references auth.users(id),
  result             text,
  coach_bewertung    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Ein Change Event erzeugt höchstens EIN Experiment (nulls kollidieren nicht).
  unique (change_event_id)
);
create index experiments_tenant_idx on public.experiments (tenant_id, status, start_date desc);
create index experiments_asin_idx on public.experiments (tenant_id, asin);

alter table public.experiments enable row level security;;

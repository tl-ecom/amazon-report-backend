-- Reimbursements-Radar (DataDoe #1). Zwei Rohdatentabellen:
--   * fba_reimbursements  = was Amazon dir ERSTATTET hat (Report GET_FBA_REIMBURSEMENTS_DATA)
--   * fba_inventar_adjustments = Inventar-Verluste/-Schäden (Ledger, event_type=Adjustments)
-- Differenz (Verlust ohne Erstattung) = potenzieller Erstattungsanspruch (Schritt 2).

create table if not exists public.fba_reimbursements (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  row_hash         text not null,
  approval_date    date,
  reimbursement_id text,
  case_id          text,
  amazon_order_id  text,
  reason           text,
  sku              text,
  fnsku            text,
  asin             text,
  product_name     text,
  condition        text,
  currency         text,
  amount_total_cents bigint,        -- amount-total in ganzen Cent (null = unbekannt)
  quantity_total   int,
  quantity_cash    int,
  quantity_inventory int,
  raw              jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, row_hash)
);
create index if not exists fba_reimbursements_asin_idx on public.fba_reimbursements (tenant_id, asin, approval_date desc);

create table if not exists public.fba_inventar_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  row_hash           text not null,
  datum              date,
  fnsku              text,
  asin               text,
  sku                text,
  product_name       text,
  event_type         text,          -- immer 'Adjustments' (beim Ingest gefiltert)
  reference_id       text,
  quantity           int,           -- signiert: negativ = entfernt/verloren
  fulfillment_center text,
  disposition        text,          -- SELLABLE / DEFECTIVE / ...
  reason             text,          -- Amazon-Grundcode (Verlust/Schaden/Fund)
  country            text,
  raw                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, row_hash)
);
create index if not exists fba_adjustments_asin_idx on public.fba_inventar_adjustments (tenant_id, asin, datum desc);
create index if not exists fba_adjustments_reason_idx on public.fba_inventar_adjustments (tenant_id, reason);

alter table public.fba_reimbursements       enable row level security;
alter table public.fba_inventar_adjustments enable row level security;;

-- Verlaufs-Tabellen für den 24-Monats-Backfill (Sales, Orders, Returns).
-- Rohnah normalisiert: die ehrliche Aggregations-Logik (unbekannt != 0,
-- item-price-Ambiguität, Mehrkanal) bleibt in der Auswertung, nicht in der
-- Speicherung. Upsert-fähig, damit überlappende/wiederholte Abrufe keine
-- Duplikate erzeugen.

-- 1) Sales & Traffic — Tagesreihe (byDate). Pro Tag eine Zeile, kontostufig.
--    (byAsin ist im Report nur ein Fenster-Aggregat, KEINE Tagesreihe — daher
--    hier bewusst keine per-ASIN-Tageswerte; Produkt-Historie kommt aus Orders.)
create table public.sales_daily (
  tenant_id           uuid  not null references public.tenants(id) on delete cascade,
  datum               date  not null,
  sessions            bigint not null default 0,
  page_views          bigint not null default 0,
  units_ordered       bigint not null default 0,
  total_order_items   bigint not null default 0,
  units_shipped       bigint not null default 0,
  orders_shipped      bigint not null default 0,
  units_refunded      bigint not null default 0,
  ordered_sales_cents bigint not null default 0,
  shipped_sales_cents bigint not null default 0,
  waehrung            text,
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, datum)
);
create index sales_daily_tenant_datum_idx on public.sales_daily (tenant_id, datum);

-- 2) Orders — pro Bestellposition eine Zeile. Preis NULLBAR (unbekannt != 0 EUR).
--    Natürlicher Schlüssel (order_id, sku); on conflict -> update (Status/Preis
--    können sich nachträglich ändern).
create table public.orders_history (
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  amazon_order_id  text not null,
  sku              text not null,
  asin             text,
  purchase_date    timestamptz,
  quantity         integer not null default 0,
  item_price_cents bigint,          -- NULL = unbekannt (z. B. MCF/Non-Amazon)
  currency         text,
  sales_channel    text,
  order_status     text,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, amazon_order_id, sku)
);
create index orders_history_tenant_date_idx on public.orders_history (tenant_id, purchase_date);
create index orders_history_tenant_asin_idx on public.orders_history (tenant_id, asin);

-- 3) Returns — Format unvalidiert: bekannte Felder extrahiert + Rohzeile als jsonb.
--    De-Dup über Hash der normalisierten Rohzeile (stabil bei Re-Pulls).
create table public.returns_history (
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  row_hash            text not null,      -- md5 der normalisierten Rohzeile
  return_request_date date,               -- best effort geparst; NULL wenn unlesbar
  asin                text,
  sku                 text,
  item_name           text,
  return_quantity     integer not null default 0,
  refunded_cents      bigint,             -- NULL = unbekannt
  currency            text,
  return_reason       text,
  resolution          text,
  return_status       text,
  raw                 jsonb,
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, row_hash)
);
create index returns_history_tenant_date_idx on public.returns_history (tenant_id, return_request_date);

-- Fortschritt des Backfills pro Tenant/Report/Chunk (idempotenter Wiederanlauf).
create table public.backfill_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  report_type  text not null,
  von          date not null,
  bis          date not null,
  status       text not null default 'pending',  -- pending | running | done | error
  detail       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, report_type, von, bis)
);
create index backfill_jobs_status_idx on public.backfill_jobs (status, tenant_id);

-- RLS aktivieren, keine Policy: nur service_role/Edge Functions greifen zu
-- (wie report_data / mcp_tokens). Normale Nutzer kommen nicht ran.
alter table public.sales_daily     enable row level security;
alter table public.orders_history  enable row level security;
alter table public.returns_history enable row level security;
alter table public.backfill_jobs   enable row level security;;

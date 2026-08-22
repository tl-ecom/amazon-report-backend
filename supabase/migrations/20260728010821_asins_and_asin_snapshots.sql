-- Kernentität ASIN + append-only ASIN-Snapshots (SKU-genau) für den Flight Recorder.
-- quantity ist NULLBAR: null = unbekannt (FBA führt Bestand hier nicht), 0 = echt
-- ausverkauft (aktives Merchant-Angebot). price ohne Währung (ergibt sich aus Marketplace).

create table public.asins (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  marketplace_id  text,
  asin            text not null,
  produktname     text,
  erstmals_gesehen timestamptz not null default now(),
  zuletzt_gesehen  timestamptz not null default now(),
  unique (tenant_id, asin)
);
create index asins_tenant_idx on public.asins (tenant_id);

create table public.asin_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  asin                text,
  seller_sku          text not null,
  snapshot_ts         timestamptz not null default now(),
  snapshot_date       date not null,
  import_report_id    text,                 -- Amazon-Report-ID (Audit/Herkunft)
  status              text,                 -- active / inactive / incomplete / …
  fulfillment_channel text,                 -- DEFAULT (Merchant) / AMAZON* (FBA), roh
  is_fba              boolean,              -- abgeleitet aus fulfillment_channel
  price               numeric,              -- NULL = kein Preis
  quantity            integer,              -- NULL = unbekannt (FBA); 0 = echt ausverkauft (Merchant)
  item_name           text,
  is_provisional      boolean not null default false,
  completeness_status text,
  raw                 jsonb,                -- Rohzeile (Audit)
  created_at          timestamptz not null default now(),
  -- Ein Snapshot je SKU je Tag; erneuter Sync am selben Tag verfeinert (Upsert),
  -- vergangene Tage bleiben unangetastet. Die Change-Engine difft über Tage.
  unique (tenant_id, seller_sku, snapshot_date)
);
create index asin_snapshots_sku_idx  on public.asin_snapshots (tenant_id, seller_sku, snapshot_date desc);
create index asin_snapshots_asin_idx on public.asin_snapshots (tenant_id, asin, snapshot_date desc);

alter table public.asins          enable row level security;
alter table public.asin_snapshots enable row level security;;

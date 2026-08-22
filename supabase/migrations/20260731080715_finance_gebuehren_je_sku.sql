-- Amazon-Gebühren je Monat × SKU × Gebührenart. Bisher gab es nur die
-- Monatssumme (finance_monatlich) — damit ist kein Nettogewinn JE PRODUKT
-- rechenbar. Quelle sind dieselben listFinancialEvents.
-- sku IS NULL = Gebühr ohne Artikelbezug (Lagergebühr, Service-Fee): sie geht
-- NICHT verloren, ist aber ehrlich nicht produktscharf zuordenbar.
create table if not exists public.finance_gebuehren (
  tenant_id uuid not null,
  monat text not null,                 -- 'YYYY-MM'
  sku text not null default '',        -- '' = ohne Artikelbezug (PK-tauglich)
  fee_typ text not null,
  betrag_cents bigint not null,        -- signiert, negativ = Kosten
  updated_at timestamptz not null default now(),
  primary key (tenant_id, monat, sku, fee_typ)
);
alter table public.finance_gebuehren enable row level security;
create index if not exists finance_gebuehren_monat_idx on public.finance_gebuehren (tenant_id, monat);;

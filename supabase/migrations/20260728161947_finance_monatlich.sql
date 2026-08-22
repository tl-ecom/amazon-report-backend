-- Monatliche Amazon-Gebühren aus der SP-API Finances API (listFinancialEvents).
-- gebuehren_cents ist die SIGNIERTE Summe aller FeeAmount (negativ = Kosten des
-- Verkäufers). Nettogewinn = Rohertrag + gebuehren_cents/100.
create table if not exists public.finance_monatlich (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  monat          text not null,           -- YYYY-MM (PostedDate)
  gebuehren_cents bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, monat)
);
alter table public.finance_monatlich enable row level security;;

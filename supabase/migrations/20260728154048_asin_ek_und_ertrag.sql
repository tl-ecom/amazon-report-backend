-- EK (Einkaufspreis/COGS) pro ASIN mit Datumsbezug (Sellerboard-Stil): mehrere
-- Einträge je ASIN über die Zeit; für eine Bestellung gilt der jüngste EK, dessen
-- gueltig_ab <= Kaufdatum liegt.
create table if not exists public.asin_ek (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  asin       text not null,
  ek_cents   integer not null check (ek_cents >= 0),   -- Einkaufspreis pro Stück
  gueltig_ab date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, asin, gueltig_ab)
);
create index if not exists asin_ek_lookup_idx on public.asin_ek (tenant_id, asin, gueltig_ab desc);
alter table public.asin_ek enable row level security;

-- Monatlicher Ertrag aus orders_history × passendem EK je Bestellung.
-- umsatz_cents = Summe der Zeilenbeträge (item_price_cents ist bereits der Zeilenwert).
-- wareneinsatz_cents = EK/Stück * Menge, nur wo ein EK bekannt ist.
-- einheiten_mit_ek zeigt die Abdeckung (Ehrlichkeit: fehlender EK != 0).
create or replace function public.ertrag_monatlich(p_tenant uuid)
returns table(monat text, umsatz_cents bigint, einheiten bigint,
              wareneinsatz_cents bigint, einheiten_mit_ek bigint)
language sql stable security definer set search_path = public as $$
  select to_char(o.purchase_date, 'YYYY-MM') as monat,
         sum(o.item_price_cents)::bigint,
         sum(o.quantity)::bigint,
         sum(coalesce(ek.ek_cents, 0) * o.quantity)::bigint,
         sum(case when ek.ek_cents is not null then o.quantity else 0 end)::bigint
  from public.orders_history o
  left join lateral (
    select e.ek_cents from public.asin_ek e
    where e.tenant_id = o.tenant_id and e.asin = o.asin
      and e.gueltig_ab <= o.purchase_date::date
    order by e.gueltig_ab desc limit 1
  ) ek on true
  where o.tenant_id = p_tenant and coalesce(o.order_status,'') <> 'Cancelled'
  group by 1 order by 1;
$$;

revoke execute on function public.ertrag_monatlich(uuid) from anon, authenticated, public;
grant  execute on function public.ertrag_monatlich(uuid) to service_role;;

-- Basis fürs Nachschub-Radar (DataDoe #4): je ASIN die Verkaufs-Velocity, der
-- letzte Verkaufstag, Tage ohne Verkauf und der Ø-Verkaufspreis aus orders_history.
-- Velocity = Einheiten im Fenster / aktive Tage (Fenster minus der jüngsten
-- Verkaufslücke, mind. 14) — so verwässern die toten Tage die Rate nicht.
-- Reine Lese-RPC; die Bewertung (leer/kritisch/buybox) macht der TS-Layer.
create or replace function public.stockout_basis(p_tenant uuid, p_tage integer default 90)
returns table(
  asin text,
  units_fenster bigint,
  letzter_verkauf date,
  tage_ohne_verkauf integer,
  avg_preis_cents integer,
  velo_tag numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with v as (
    select o.asin,
           sum(o.quantity) filter (where o.purchase_date >= now() - (p_tage || ' days')::interval) as units_fenster,
           max(o.purchase_date)::date as letzter_verkauf,
           round(avg(o.item_price_cents::numeric / nullif(o.quantity, 0))
                 filter (where o.purchase_date >= now() - (p_tage || ' days')::interval))::int as avg_preis_cents
    from public.orders_history o
    where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
    group by o.asin
  )
  select v.asin,
         coalesce(v.units_fenster, 0) as units_fenster,
         v.letzter_verkauf,
         (current_date - v.letzter_verkauf)::int as tage_ohne_verkauf,
         v.avg_preis_cents,
         round(
           coalesce(v.units_fenster, 0)::numeric
           / greatest(14, p_tage - least((current_date - v.letzter_verkauf)::int, 60))::numeric,
           3
         ) as velo_tag
  from v
  where coalesce(v.units_fenster, 0) > 0;
$function$;

revoke all on function public.stockout_basis(uuid, integer) from public, anon, authenticated;
grant execute on function public.stockout_basis(uuid, integer) to service_role;;

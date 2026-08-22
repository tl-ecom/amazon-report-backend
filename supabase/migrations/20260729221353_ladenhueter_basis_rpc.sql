-- Basis fürs Ladenhüter-Radar (DataDoe #5: Dead Stock / Slow Mover).
-- Je ASIN: Lifetime-Umsatz/Einheiten, jüngstes Fenster (0–30 Tage) und
-- Vorquartal (30–120 Tage), erster/letzter Verkauf, Tage ohne Verkauf.
-- Reine Lese-RPC; die Einstufung (tot/abkühlend) macht der TS-Layer.
create or replace function public.ladenhueter_basis(p_tenant uuid)
returns table(
  asin text,
  lifetime_units bigint,
  lifetime_umsatz_cents bigint,
  units_0_30 bigint,
  umsatz_0_30_cents bigint,
  units_30_120 bigint,
  umsatz_30_120_cents bigint,
  erster_verkauf date,
  letzter_verkauf date,
  tage_ohne_verkauf integer
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.asin,
         sum(o.quantity)::bigint as lifetime_units,
         coalesce(sum(o.item_price_cents), 0)::bigint as lifetime_umsatz_cents,
         coalesce(sum(o.quantity) filter (where o.purchase_date >= now() - interval '30 days'), 0)::bigint as units_0_30,
         coalesce(sum(o.item_price_cents) filter (where o.purchase_date >= now() - interval '30 days'), 0)::bigint as umsatz_0_30_cents,
         coalesce(sum(o.quantity) filter (where o.purchase_date >= now() - interval '120 days' and o.purchase_date < now() - interval '30 days'), 0)::bigint as units_30_120,
         coalesce(sum(o.item_price_cents) filter (where o.purchase_date >= now() - interval '120 days' and o.purchase_date < now() - interval '30 days'), 0)::bigint as umsatz_30_120_cents,
         min(o.purchase_date)::date as erster_verkauf,
         max(o.purchase_date)::date as letzter_verkauf,
         (current_date - max(o.purchase_date)::date)::int as tage_ohne_verkauf
  from public.orders_history o
  where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
  group by o.asin
  having sum(o.quantity) > 0;
$function$;

revoke all on function public.ladenhueter_basis(uuid) from public, anon, authenticated;
grant execute on function public.ladenhueter_basis(uuid) to service_role;;

-- Nachschub-Radar auf ECHTE Bestände umstellen. Bisher wurde der Ausverkauf nur
-- aus Verkaufslücken erschlossen; jetzt kommt der Lagerbestand dazu:
--   bestand            verkaufsfähige Menge (fba_bestand, je SKU -> je ASIN)
--   nachschub_unterwegs  shipped + working + receiving
--   reichweite_tage    bestand / Velocity = Tage bis leer (NULL wenn unbekannt)
-- Bestand NULL = kein Lagerdatensatz (unbekannt), niemals 0 erfunden.
-- Stornos werden jetzt auch hier ausgeschlossen (war vorher nicht gefiltert).
drop function if exists public.stockout_basis(uuid, integer);

create function public.stockout_basis(p_tenant uuid, p_tage integer default 90)
returns table(
  asin text, units_fenster bigint, letzter_verkauf date, tage_ohne_verkauf integer,
  avg_preis_cents integer, velo_tag numeric,
  bestand integer, nachschub_unterwegs integer, bestand_bekannt boolean,
  reichweite_tage numeric
)
language sql stable security definer set search_path to 'public'
as $function$
  with v as (
    select o.asin,
           sum(o.quantity) filter (where o.purchase_date >= now() - (p_tage || ' days')::interval) as units_fenster,
           max(o.purchase_date)::date as letzter_verkauf,
           round(avg(o.item_price_cents::numeric / nullif(o.quantity, 0))
                 filter (where o.purchase_date >= now() - (p_tage || ' days')::interval))::int as avg_preis_cents
    from public.orders_history o
    where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
      and coalesce(o.order_status, '') <> 'Cancelled'
    group by o.asin
  ),
  lager as (
    select f.asin,
           sum(coalesce(f.verkaufsfaehig, 0))::int as bestand,
           sum(coalesce(f.inbound_shipped,0) + coalesce(f.inbound_working,0) + coalesce(f.inbound_receiving,0))::int as unterwegs
    from public.fba_bestand f
    where f.tenant_id = p_tenant and f.asin is not null
    group by f.asin
  ),
  velo as (
    select v.*,
           round(
             coalesce(v.units_fenster, 0)::numeric
             / greatest(14, p_tage - least((current_date - v.letzter_verkauf)::int, 60))::numeric,
             3
           ) as velo_tag
    from v
  )
  select velo.asin,
         coalesce(velo.units_fenster, 0) as units_fenster,
         velo.letzter_verkauf,
         (current_date - velo.letzter_verkauf)::int as tage_ohne_verkauf,
         velo.avg_preis_cents,
         velo.velo_tag,
         l.bestand,
         l.unterwegs as nachschub_unterwegs,
         (l.asin is not null) as bestand_bekannt,
         -- Tage bis leer. Ohne Bestandsdaten oder ohne Velocity: NULL = unbekannt.
         case when l.asin is null or velo.velo_tag <= 0 then null
              else round(l.bestand::numeric / velo.velo_tag, 1) end as reichweite_tage
  from velo
  left join lager l on l.asin = velo.asin
  where coalesce(velo.units_fenster, 0) > 0;
$function$;

revoke all on function public.stockout_basis(uuid, integer) from public, anon, authenticated;
grant execute on function public.stockout_basis(uuid, integer) to service_role;;

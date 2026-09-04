-- Nachschub liest den Bestand jetzt ueber public.bestand_je_asin und bekommt
-- damit die frischere der beiden Quellen. Waehrend des Amazon-Ausfalls vom
-- 03./04.09. rechnete die Reichweite sonst auf einem 61 Stunden alten Stand.
--
-- Zwei neue Ausgabespalten, damit der Rueckfall SICHTBAR ist: `bestand_stand`
-- und `bestand_quelle`. Eine stillschweigend gewechselte Datenquelle waere
-- schlimmer als der veraltete Stand — man wuerde den Zahlen vertrauen, ohne zu
-- wissen, woher sie kommen.
--
-- `nachschub_unterwegs` kann jetzt NULL sein: Der Planungsreport kennt keine
-- Zulaufmengen. NULL heisst unbekannt, nicht null Stueck.
--
-- Auf ASIN-Ebene kostet der Wechsel nichts: 35 ASINs in beiden Quellen, 34
-- gemeinsam, und die eine nur im alten Report hat 0 Stueck.

drop function if exists public.stockout_basis(uuid, integer);

create function public.stockout_basis(p_tenant uuid, p_tage integer default 90)
returns table(asin text, units_fenster bigint, letzter_verkauf date,
              tage_ohne_verkauf integer, avg_preis_cents integer, velo_tag numeric,
              bestand integer, nachschub_unterwegs integer, bestand_bekannt boolean,
              reichweite_tage numeric, bestand_stand timestamptz, bestand_quelle text)
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
      and coalesce(o.order_status, '') <> 'Cancelled'
    group by o.asin
  ),
  lager as (
    select b.asin, b.bestand, b.unterwegs, b.stand, b.quelle
    from public.bestand_je_asin(p_tenant) b
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
              else round(l.bestand::numeric / velo.velo_tag, 1) end as reichweite_tage,
         l.stand as bestand_stand,
         l.quelle as bestand_quelle
  from velo
  left join lager l on l.asin = velo.asin
  where coalesce(velo.units_fenster, 0) > 0;
$function$;

revoke all on function public.stockout_basis(uuid, integer) from public, anon, authenticated;
grant execute on function public.stockout_basis(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

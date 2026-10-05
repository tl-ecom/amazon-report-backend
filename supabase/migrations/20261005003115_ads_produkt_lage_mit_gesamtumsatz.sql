-- Lage je Produkt bekommt den Gesamtumsatz dazu (Bestellungen aller Herkunft,
-- nicht nur Werbung) — daraus rechnet _shared/ads_produkt_lage.ts TACoS und
-- den Anteil der Werbung am Umsatz. Welche ASINs zu einem Produkt gehoeren,
-- ergibt sich aus den Kampagnen des Produkts: was sie in den letzten 90 Tagen
-- beworben haben.
create or replace function public.ads_produkt_lage(
  p_tenant uuid, p_marktplatz text, p_tage integer default 7
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with t as (select greatest(1, least(coalesce(p_tage, 7), 60)) as n),
  ende as (
    select max(datum) as d from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  gesteuert as (
    select campaign_id, produkt, modus from public.ads_steuerung
     where tenant_id = p_tenant and modus <> 'nur_analyse' and produkt is not null
  ),
  summen as (
    select s.produkt, s.modus,
           case when a.datum > ende.d - t.n then 'aktuell' else 'davor' end as fenster,
           count(distinct a.campaign_id) as kampagnen,
           sum(a.impressions) as impressions, sum(a.clicks) as clicks,
           sum(a.spend_cents) as spend_cents, sum(a.sales_cents) as sales_cents, sum(a.orders) as orders
      from gesteuert s
      cross join ende cross join t
      join public.ads_daily a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz
                             and a.datum > ende.d - 2 * t.n and a.datum <= ende.d
     group by 1, 2, 3
  ),
  produkt_asins as (
    select distinct s.produkt, a.asin
      from gesteuert s cross join ende
      join public.ads_daily a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz and a.asin <> ''
                             and a.datum > ende.d - 90
  ),
  -- Eine ASIN, die Kampagnen zweier Produkte bewerben, laesst sich keinem
  -- zuordnen. Sie bleibt draussen und wird gemeldet, statt doppelt zu zaehlen.
  eindeutig as (
    select asin, min(produkt) as produkt from produkt_asins group by asin having count(*) = 1
  ),
  gesamt as (
    select e.produkt,
           case when (o.purchase_date at time zone 'Europe/Berlin')::date > ende.d - t.n then 'aktuell' else 'davor' end as fenster,
           sum(o.item_price_cents) as umsatz_cents, sum(o.quantity) as einheiten,
           count(*) filter (where o.item_price_cents is null) as ohne_preis
      from eindeutig e cross join ende cross join t
      join public.orders_history o on o.tenant_id = p_tenant and o.asin = e.asin
     where (o.purchase_date at time zone 'Europe/Berlin')::date > ende.d - 2 * t.n
       and (o.purchase_date at time zone 'Europe/Berlin')::date <= ende.d
       and coalesce(o.order_status, '') not ilike '%cancel%'
       and o.sales_channel = case p_marktplatz
             when 'A1PA6795UKMFR9' then 'Amazon.de' when 'A13V1IB3VIYZZH' then 'Amazon.fr'
             when 'APJ6JRA9NG5V4' then 'Amazon.it' when 'A1RKKUPIHCS9HS' then 'Amazon.es'
             when 'A1805IZSGTT6HS' then 'Amazon.nl' else o.sales_channel end
     group by 1, 2
  ),
  -- Kampagnentage mit leerem Budget in den letzten p_tage Kalendertagen. Der
  -- Vortagesstand kurz nach Mitternacht zaehlt nicht (wie in ads_budget_tage).
  leer as (
    select s.produkt, count(distinct (b.campaign_id, (b.gemessen_am at time zone 'Europe/Berlin')::date)) as kampagnentage
      from gesteuert s cross join t
      join public.ads_budget_auslastung b on b.tenant_id = p_tenant and b.campaign_id = s.campaign_id
                                         and b.marktplatz = p_marktplatz
     where b.auslastung_prozent >= 100
       and b.gemessen_am > now() - make_interval(days => t.n)
       and (b.amazon_stand at time zone 'Europe/Berlin')::date = (b.gemessen_am at time zone 'Europe/Berlin')::date
     group by 1
  )
  select jsonb_build_object(
    'letzter_tag', (select d from ende),
    'tage', (select n from t),
    'zeilen', coalesce((select jsonb_agg(to_jsonb(summen)) from summen), '[]'::jsonb),
    'gesamtumsatz', coalesce((select jsonb_agg(to_jsonb(gesamt)) from gesamt), '[]'::jsonb),
    'asins', coalesce((select jsonb_object_agg(produkt, a) from
                        (select produkt, jsonb_agg(asin order by asin) as a from eindeutig group by 1) x), '{}'::jsonb),
    'asins_mehrdeutig', coalesce((select jsonb_agg(distinct asin) from produkt_asins
                                   where asin not in (select asin from eindeutig)), '[]'::jsonb),
    'budget_leer', coalesce((select jsonb_object_agg(produkt, kampagnentage) from leer), '{}'::jsonb)
  );
$function$;

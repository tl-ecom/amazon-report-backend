-- Verlauf je verwaltetem Produkt: je Tag Werbekosten, Werbeumsatz und der
-- Umsatz aus allen Bestellungen. Gleiche Zuordnung wie ads_produkt_lage
-- (Kampagnen aus ads_steuerung, ASINs aus dem, was sie 90 Tage beworben haben).
-- Jeder Tag steht da, auch ohne Bewegung — sonst zieht ein Diagramm Luecken zu.
create or replace function public.ads_produkt_verlauf(
  p_tenant uuid, p_marktplatz text, p_tage integer default 42
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with t as (select greatest(7, least(coalesce(p_tage, 42), 180)) as n),
  ende as (
    select max(datum) as d from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  gesteuert as (
    select campaign_id, produkt from public.ads_steuerung
     where tenant_id = p_tenant and modus <> 'nur_analyse' and produkt is not null
  ),
  werbung as (
    select s.produkt, a.datum, sum(a.spend_cents) as spend_cents, sum(a.sales_cents) as sales_cents,
           sum(a.orders) as orders, sum(a.clicks) as clicks
      from gesteuert s cross join ende cross join t
      join public.ads_daily a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz
                             and a.datum > ende.d - t.n and a.datum <= ende.d
     group by 1, 2
  ),
  produkt_asins as (
    select distinct s.produkt, a.asin
      from gesteuert s cross join ende
      join public.ads_daily a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz and a.asin <> ''
                             and a.datum > ende.d - 90
  ),
  eindeutig as (
    select asin, min(produkt) as produkt from produkt_asins group by asin having count(*) = 1
  ),
  bestellt as (
    select e.produkt, (o.purchase_date at time zone 'Europe/Berlin')::date as datum,
           sum(o.item_price_cents) as umsatz_cents, sum(o.quantity) as einheiten
      from eindeutig e cross join ende cross join t
      join public.orders_history o on o.tenant_id = p_tenant and o.asin = e.asin
     where (o.purchase_date at time zone 'Europe/Berlin')::date > ende.d - t.n
       and (o.purchase_date at time zone 'Europe/Berlin')::date <= ende.d
       and coalesce(o.order_status, '') not ilike '%cancel%'
       and o.sales_channel = case p_marktplatz
             when 'A1PA6795UKMFR9' then 'Amazon.de' when 'A13V1IB3VIYZZH' then 'Amazon.fr'
             when 'APJ6JRA9NG5V4' then 'Amazon.it' when 'A1RKKUPIHCS9HS' then 'Amazon.es'
             when 'A1805IZSGTT6HS' then 'Amazon.nl' else o.sales_channel end
     group by 1, 2
  ),
  raster as (
    select p.produkt, g::date as datum
      from (select distinct produkt from gesteuert) p cross join ende cross join t,
           generate_series(ende.d - (t.n - 1), ende.d, interval '1 day') g
  )
  select jsonb_build_object(
    'letzter_tag', (select d from ende),
    'tage', (select n from t),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
               'produkt', r.produkt, 'datum', r.datum,
               'spend_cents', coalesce(w.spend_cents, 0), 'sales_cents', coalesce(w.sales_cents, 0),
               'orders', coalesce(w.orders, 0), 'clicks', coalesce(w.clicks, 0),
               'umsatz_cents', coalesce(b.umsatz_cents, 0), 'einheiten', coalesce(b.einheiten, 0))
             order by r.produkt, r.datum)
        from raster r
        left join werbung w on w.produkt = r.produkt and w.datum = r.datum
        left join bestellt b on b.produkt = r.produkt and b.datum = r.datum
    ), '[]'::jsonb),
    'produkte_ohne_asin', coalesce((
      select jsonb_agg(p.produkt) from (select distinct produkt from gesteuert) p
       where not exists (select 1 from eindeutig e where e.produkt = p.produkt)), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_produkt_verlauf(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.ads_produkt_verlauf(uuid, text, integer) to service_role;
notify pgrst, 'reload schema';

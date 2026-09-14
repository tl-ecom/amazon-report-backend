-- ads_summen ist die meistgenutzte Ads-Lesefunktion: Uebersicht, Betriebskosten
-- und der Werbeblock haengen daran. Ohne Marktplatz-Filter waeren das die
-- ersten Zahlen, die nach dem Freischalten von Frankreich still falsch werden.
create or replace function public.ads_summen(
  p_tenant uuid, p_von date, p_bis date, p_marktplatz text default null)
returns table(ebene text, schluessel text, bezeichnung text, impressions bigint,
              clicks bigint, spend_cents bigint, sales_cents bigint, orders bigint,
              einheiten bigint)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id),
  basis as (
    select d.* from public.ads_daily d, mp
    where d.tenant_id = p_tenant and d.marktplatz = mp.id
      and d.datum between p_von and p_bis
  )
  select 'gesamt'::text, null::text, null::text,
         coalesce(sum(impressions),0)::bigint, coalesce(sum(clicks),0)::bigint,
         coalesce(sum(spend_cents),0)::bigint, coalesce(sum(sales_cents),0)::bigint,
         coalesce(sum(orders),0)::bigint, coalesce(sum(einheiten),0)::bigint
  from basis

  union all
  select 'tag', datum::text, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by datum

  union all
  select 'kampagne', campaign_id, nullif(max(coalesce(campaign_name,'')),''),
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by campaign_id

  union all
  -- Nur Zeilen MIT ASIN. Sponsored Brands haben keine; sie hier mitzuzaehlen
  -- ergaebe ein Produkt namens "" mit vierstelligen Kosten.
  select 'asin', asin, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis where coalesce(asin,'') <> '' group by asin

  union all
  select 'ad_product', ad_product, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by ad_product

  union all
  select 'ohne_asin', null::text, null::text,
         coalesce(sum(impressions),0)::bigint, coalesce(sum(clicks),0)::bigint,
         coalesce(sum(spend_cents),0)::bigint, coalesce(sum(sales_cents),0)::bigint,
         coalesce(sum(orders),0)::bigint, coalesce(sum(einheiten),0)::bigint
  from basis where coalesce(asin,'') = ''
$function$;

drop function if exists public.ads_summen(uuid, date, date);

revoke all on function public.ads_summen(uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.ads_summen(uuid, date, date, text) to service_role;

-- Changelog ebenfalls: er liest dieselben Tagesdaten.
create or replace function public.ads_changelog(
  p_tenant uuid, p_von date default null, p_bis date default null,
  p_campaign_id text default null, p_limit integer default 200,
  p_min_klicks integer default 0, p_marktplatz text default null)
returns table(
  am date, luecke_tage integer, art text, ad_product text,
  campaign_id text, campaign_name text, ad_group_name text,
  ziel_id text, ziel_text text, match_type text,
  vorher text, nachher text, richtung text,
  vorher_impressions bigint, vorher_clicks bigint, vorher_spend_cents bigint,
  vorher_sales_cents bigint, vorher_orders bigint,
  nachher_impressions bigint, nachher_clicks bigint, nachher_spend_cents bigint,
  nachher_sales_cents bigint, nachher_orders bigint,
  nachlauf_vollstaendig boolean)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id),
  grenzen as (
    select coalesce(p_von, current_date - 90) as von,
           coalesce(p_bis, current_date)      as bis,
           (select max(d.datum) from public.ads_ziele_daily d, mp
             where d.tenant_id = p_tenant and d.marktplatz = mp.id) as letzter_tag
  ),
  reihe as (
    select d.ziel_id, d.datum, d.gebot_cents, d.state, d.ad_product,
           d.campaign_id, d.campaign_name, d.ad_group_name, d.text, d.match_type,
           lag(d.gebot_cents) over w as gebot_vor,
           lag(d.state)       over w as state_vor,
           lag(d.datum)       over w as datum_vor
    from public.ads_ziele_daily d, mp
    where d.tenant_id = p_tenant and d.marktplatz = mp.id
      and (p_campaign_id is null or d.campaign_id = p_campaign_id)
    window w as (partition by d.ziel_id order by d.datum)
  ),
  ereignisse as (
    select datum, datum_vor, 'gebot'::text as art, ad_product, campaign_id, campaign_name,
           ad_group_name, ziel_id, text, match_type,
           to_char(gebot_vor / 100.0, 'FM999990.00')   as vorher,
           to_char(gebot_cents / 100.0, 'FM999990.00') as nachher,
           case when gebot_cents > gebot_vor then 'hoch'
                when gebot_cents < gebot_vor then 'runter'
                else 'gleich' end as richtung
    from reihe
    where gebot_vor is not null and gebot_cents is not null
      and gebot_cents is distinct from gebot_vor
    union all
    select datum, datum_vor, 'status', ad_product, campaign_id, campaign_name,
           ad_group_name, ziel_id, text, match_type,
           state_vor, state,
           case when state = 'ENABLED' then 'hoch'
                when state_vor = 'ENABLED' then 'runter'
                else 'gleich' end
    from reihe
    where state_vor is not null and state is not null
      and state is distinct from state_vor
  ),
  gefiltert as (
    select e.* from ereignisse e, grenzen g
    where e.datum between g.von and g.bis
  ),
  mit_zahlen as (
    select f.*,
      (select coalesce(sum(v.impressions),0) from public.ads_ziele_daily v, mp
        where v.tenant_id = p_tenant and v.marktplatz = mp.id and v.ziel_id = f.ziel_id
          and v.datum between f.datum - 7 and f.datum - 1) as v_imp,
      (select coalesce(sum(v.clicks),0) from public.ads_ziele_daily v, mp
        where v.tenant_id = p_tenant and v.marktplatz = mp.id and v.ziel_id = f.ziel_id
          and v.datum between f.datum - 7 and f.datum - 1) as v_clk,
      (select coalesce(sum(v.spend_cents),0) from public.ads_ziele_daily v, mp
        where v.tenant_id = p_tenant and v.marktplatz = mp.id and v.ziel_id = f.ziel_id
          and v.datum between f.datum - 7 and f.datum - 1) as v_spend,
      (select coalesce(sum(v.sales_cents),0) from public.ads_ziele_daily v, mp
        where v.tenant_id = p_tenant and v.marktplatz = mp.id and v.ziel_id = f.ziel_id
          and v.datum between f.datum - 7 and f.datum - 1) as v_sales,
      (select coalesce(sum(v.orders),0) from public.ads_ziele_daily v, mp
        where v.tenant_id = p_tenant and v.marktplatz = mp.id and v.ziel_id = f.ziel_id
          and v.datum between f.datum - 7 and f.datum - 1) as v_ord,
      (select coalesce(sum(n.impressions),0) from public.ads_ziele_daily n, mp
        where n.tenant_id = p_tenant and n.marktplatz = mp.id and n.ziel_id = f.ziel_id
          and n.datum between f.datum and f.datum + 6) as n_imp,
      (select coalesce(sum(n.clicks),0) from public.ads_ziele_daily n, mp
        where n.tenant_id = p_tenant and n.marktplatz = mp.id and n.ziel_id = f.ziel_id
          and n.datum between f.datum and f.datum + 6) as n_clk,
      (select coalesce(sum(n.spend_cents),0) from public.ads_ziele_daily n, mp
        where n.tenant_id = p_tenant and n.marktplatz = mp.id and n.ziel_id = f.ziel_id
          and n.datum between f.datum and f.datum + 6) as n_spend,
      (select coalesce(sum(n.sales_cents),0) from public.ads_ziele_daily n, mp
        where n.tenant_id = p_tenant and n.marktplatz = mp.id and n.ziel_id = f.ziel_id
          and n.datum between f.datum and f.datum + 6) as n_sales,
      (select coalesce(sum(n.orders),0) from public.ads_ziele_daily n, mp
        where n.tenant_id = p_tenant and n.marktplatz = mp.id and n.ziel_id = f.ziel_id
          and n.datum between f.datum and f.datum + 6) as n_ord
    from gefiltert f
  )
  select m.datum,
         greatest((m.datum - m.datum_vor) - 1, 0)::integer,
         m.art, m.ad_product, m.campaign_id, m.campaign_name, m.ad_group_name,
         m.ziel_id, m.text, m.match_type, m.vorher, m.nachher, m.richtung,
         m.v_imp, m.v_clk, m.v_spend, m.v_sales, m.v_ord,
         m.n_imp, m.n_clk, m.n_spend, m.n_sales, m.n_ord,
         (g.letzter_tag >= m.datum + 6)
  from mit_zahlen m, grenzen g
  where coalesce(p_min_klicks, 0) = 0
     or (m.v_clk >= p_min_klicks and m.n_clk >= p_min_klicks)
  order by m.datum desc, m.campaign_name nulls last, m.text nulls last
  limit greatest(1, least(coalesce(p_limit, 200), 2000));
$function$;

drop function if exists public.ads_changelog(uuid, date, date, text, integer, integer);

revoke all on function public.ads_changelog(uuid, date, date, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ads_changelog(uuid, date, date, text, integer, integer, text) to service_role;

notify pgrst, 'reload schema';;

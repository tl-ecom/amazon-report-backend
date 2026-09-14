create or replace function public.ads_suchbegriffe_summen(
  p_tenant uuid, p_von date, p_bis date, p_campaign text default null,
  p_limit integer default 500, p_ad_product text default null,
  p_marktplatz text default null)
returns table(ad_product text, campaign_id text, campaign_name text, ad_group_id text,
              ad_group_name text, ziel_id text, ziel_text text, match_type text,
              suchbegriff text, impressions bigint, clicks bigint, spend_cents bigint,
              sales_cents bigint, orders bigint, einheiten bigint, tage integer)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id)
  select d.ad_product, d.campaign_id,
         nullif(max(coalesce(d.campaign_name,'')),''),
         d.ad_group_id,
         nullif(max(coalesce(d.ad_group_name,'')),''),
         d.ziel_id,
         nullif(max(coalesce(d.ziel_text,'')),''),
         nullif(max(coalesce(d.match_type,'')),''),
         d.suchbegriff,
         sum(d.impressions)::bigint, sum(d.clicks)::bigint,
         sum(d.spend_cents)::bigint, sum(d.sales_cents)::bigint,
         sum(d.orders)::bigint, sum(d.einheiten)::bigint,
         count(distinct d.datum)::int
  from public.ads_suchbegriffe_daily d, mp
  where d.tenant_id = p_tenant and d.marktplatz = mp.id
    and d.datum between p_von and p_bis
    and (p_campaign is null or d.campaign_id = p_campaign)
    and (p_ad_product is null or d.ad_product = p_ad_product)
  group by d.ad_product, d.campaign_id, d.ad_group_id, d.ziel_id, d.suchbegriff
  order by sum(d.spend_cents) desc, sum(d.clicks) desc
  limit greatest(1, least(p_limit, 5000))
$function$;

create or replace function public.ads_ziele_summen(
  p_tenant uuid, p_von date, p_bis date, p_campaign text default null,
  p_limit integer default 500, p_ad_product text default null,
  p_marktplatz text default null)
returns table(ad_product text, campaign_id text, campaign_name text, ad_group_id text,
              ad_group_name text, ziel_id text, text text, match_type text,
              gebot_cents bigint, state text, impressions bigint, clicks bigint,
              spend_cents bigint, sales_cents bigint, orders bigint, einheiten bigint,
              tage integer)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id)
  select d.ad_product, d.campaign_id,
         nullif(max(coalesce(d.campaign_name,'')),''),
         d.ad_group_id,
         nullif(max(coalesce(d.ad_group_name,'')),''),
         d.ziel_id,
         nullif(max(coalesce(d.text,'')),''),
         nullif(max(coalesce(d.match_type,'')),''),
         (array_agg(d.gebot_cents order by d.datum desc))[1],
         (array_agg(d.state order by d.datum desc))[1],
         sum(d.impressions)::bigint, sum(d.clicks)::bigint,
         sum(d.spend_cents)::bigint, sum(d.sales_cents)::bigint,
         sum(d.orders)::bigint, sum(d.einheiten)::bigint,
         count(distinct d.datum)::int
  from public.ads_ziele_daily d, mp
  where d.tenant_id = p_tenant and d.marktplatz = mp.id
    and d.datum between p_von and p_bis
    and (p_campaign is null or d.campaign_id = p_campaign)
    and (p_ad_product is null or d.ad_product = p_ad_product)
  group by d.ad_product, d.campaign_id, d.ad_group_id, d.ziel_id
  order by sum(d.spend_cents) desc, sum(d.clicks) desc
  limit greatest(1, least(p_limit, 5000))
$function$;

create or replace function public.ads_selbstblockaden(
  p_tenant uuid, p_stand timestamptz, p_marktplatz text default null)
returns table(campaign_id text, campaign_name text, ad_group_id text, keyword_id text,
              keyword text, keyword_match text, gebot_cents bigint, negative_id text,
              negative text, negative_match text, negative_ebene text)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id)
  select k.campaign_id, c.name, k.ad_group_id,
         k.ziel_id, k.text, k.match_type, k.gebot_cents,
         n.ziel_id, n.text, n.match_type,
         case when n.art like 'kampagne_%' then 'kampagne' else 'anzeigengruppe' end
  from public.ads_ziele k
  cross join mp
  -- Der Join haengt jetzt auch am Marktplatz: ein negatives Keyword aus
  -- Frankreich darf kein deutsches Keyword blockieren.
  join public.ads_ziele n
    on n.tenant_id = k.tenant_id and n.marktplatz = k.marktplatz
   and n.gesehen_am = k.gesehen_am
   and n.campaign_id = k.campaign_id
   and n.art in ('negativ_keyword', 'kampagne_negativ_keyword')
   and n.state = 'ENABLED'
   and (n.art = 'kampagne_negativ_keyword' or n.ad_group_id = k.ad_group_id)
   and (
        (k.match_type = 'EXACT' and n.match_type = 'NEGATIVE_EXACT'
           and lower(n.text) = lower(k.text))
     or (k.match_type in ('EXACT', 'PHRASE') and n.match_type = 'NEGATIVE_PHRASE'
           and ' ' || lower(k.text) || ' ' like '% ' || lower(n.text) || ' %')
   )
  left join public.ads_kampagnen c
    on c.tenant_id = k.tenant_id and c.marktplatz = k.marktplatz and c.campaign_id = k.campaign_id
  where k.tenant_id = p_tenant and k.marktplatz = mp.id and k.gesehen_am = p_stand
    and k.art = 'keyword' and k.state = 'ENABLED'
  order by k.campaign_id, k.text
$function$;

drop function if exists public.ads_suchbegriffe_summen(uuid, date, date, text, integer, text);
drop function if exists public.ads_ziele_summen(uuid, date, date, text, integer, text);
drop function if exists public.ads_selbstblockaden(uuid, timestamptz);

revoke all on function public.ads_suchbegriffe_summen(uuid, date, date, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.ads_ziele_summen(uuid, date, date, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.ads_selbstblockaden(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ads_suchbegriffe_summen(uuid, date, date, text, integer, text, text) to service_role;
grant execute on function public.ads_ziele_summen(uuid, date, date, text, integer, text, text) to service_role;
grant execute on function public.ads_selbstblockaden(uuid, timestamptz, text) to service_role;

notify pgrst, 'reload schema';;

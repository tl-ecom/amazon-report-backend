-- Ads-Leser filtern ab jetzt auf EINEN Marktplatz.
--
-- Ohne Angabe den der SP-Verbindung — bestehende Ansichten bleiben damit Zeichen
-- fuer Zeichen gleich, weil heute ohnehin nur ein Marktplatz in den Tabellen
-- steht. Sobald Frankreich dazukommt, mischen sie NICHT: das waere die
-- gefaehrlichste Art von Fehler, weil das Ergebnis plausibel aussieht.

create or replace function public.ads_placement_summen(
  p_tenant uuid, p_von date, p_bis date, p_ad_product text default null,
  p_marktplatz text default null)
returns table(ebene text, ad_product text, campaign_id text, campaign_name text,
              platzierung text, impressions bigint, clicks bigint, spend_cents bigint,
              sales_cents bigint, orders bigint, einheiten bigint)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id),
  basis as (
    select d.* from public.ads_placement_daily d, mp
    where d.tenant_id = p_tenant and d.marktplatz = mp.id
      and d.datum between p_von and p_bis
      and (p_ad_product is null or d.ad_product = p_ad_product)
  )
  select 'gesamt'::text, ad_product, null::text, null::text, platzierung,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by ad_product, platzierung
  union all
  select 'kampagne', ad_product, campaign_id, nullif(max(coalesce(campaign_name,'')),''), platzierung,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by ad_product, campaign_id, platzierung
$function$;

create or replace function public.ads_tagesreihen_abdeckung(
  p_tenant uuid, p_marktplatz text default null)
returns table(tabelle text, ad_product text, von date, bis date, tage bigint)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id)
  select 'suchbegriffe'::text, d.ad_product, min(d.datum), max(d.datum), count(distinct d.datum)
  from public.ads_suchbegriffe_daily d, mp
  where d.tenant_id = p_tenant and d.marktplatz = mp.id group by d.ad_product
  union all
  select 'placement'::text, d.ad_product, min(d.datum), max(d.datum), count(distinct d.datum)
  from public.ads_placement_daily d, mp
  where d.tenant_id = p_tenant and d.marktplatz = mp.id group by d.ad_product
  union all
  select 'ziele'::text, d.ad_product, min(d.datum), max(d.datum), count(distinct d.datum)
  from public.ads_ziele_daily d, mp
  where d.tenant_id = p_tenant and d.marktplatz = mp.id group by d.ad_product
$function$;

create or replace function public.ads_ziele_zaehler(
  p_tenant uuid, p_stand timestamptz, p_marktplatz text default null)
returns table(campaign_id text, art text, anzahl bigint)
language sql stable security definer set search_path to 'public'
as $function$
  with mp as (select coalesce(p_marktplatz, public.ads_haupt_marktplatz(p_tenant)) as id)
  select z.campaign_id, z.art, count(*)::bigint
  from public.ads_ziele z, mp
  where z.tenant_id = p_tenant and z.marktplatz = mp.id and z.gesehen_am = p_stand
  group by z.campaign_id, z.art
$function$;

drop function if exists public.ads_placement_summen(uuid, date, date, text);
drop function if exists public.ads_tagesreihen_abdeckung(uuid);
drop function if exists public.ads_ziele_zaehler(uuid, timestamptz);

revoke all on function public.ads_placement_summen(uuid, date, date, text, text) from public, anon, authenticated;
revoke all on function public.ads_tagesreihen_abdeckung(uuid, text) from public, anon, authenticated;
revoke all on function public.ads_ziele_zaehler(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ads_placement_summen(uuid, date, date, text, text) to service_role;
grant execute on function public.ads_tagesreihen_abdeckung(uuid, text) to service_role;
grant execute on function public.ads_ziele_zaehler(uuid, timestamptz, text) to service_role;

notify pgrst, 'reload schema';;

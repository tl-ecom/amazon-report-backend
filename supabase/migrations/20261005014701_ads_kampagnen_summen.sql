-- Summen je gesteuerter Kampagne ueber die letzten p_tage Tage mit Ads-Daten,
-- mit Produkt und Steuerung aus ads_steuerung. Fuer den Kampagnen-Ertrag
-- (_shared/ads_kampagnen_ertrag.ts): dort kommt die Marge des Produkts dazu.
create or replace function public.ads_kampagnen_summen(
  p_tenant uuid, p_marktplatz text, p_tage integer default 30
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with t as (select greatest(1, least(coalesce(p_tage, 30), 90)) as n),
  ende as (
    select max(datum) as d from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  summen as (
    select s.campaign_id, s.produkt, s.modus, max(a.campaign_name) as campaign_name, max(a.ad_product) as ad_product,
           sum(a.impressions) as impressions, sum(a.clicks) as clicks,
           sum(a.spend_cents) as spend_cents, sum(a.sales_cents) as sales_cents, sum(a.orders) as orders,
           count(distinct a.datum) filter (where a.impressions > 0) as tage_aktiv
      from public.ads_steuerung s cross join ende cross join t
      join public.ads_daily a on a.tenant_id = s.tenant_id and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz
                             and a.datum > ende.d - t.n and a.datum <= ende.d
     where s.tenant_id = p_tenant and s.modus <> 'nur_analyse' and s.produkt is not null
     group by 1, 2, 3
    having sum(a.impressions) > 0
  )
  select jsonb_build_object(
    'letzter_tag', (select d from ende),
    'tage', (select n from t),
    'zeilen', coalesce((select jsonb_agg(to_jsonb(summen)) from summen), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_kampagnen_summen(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.ads_kampagnen_summen(uuid, text, integer) to service_role;
notify pgrst, 'reload schema';

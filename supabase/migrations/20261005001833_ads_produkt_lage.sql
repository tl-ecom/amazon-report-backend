-- Lage je verwaltetem Produkt: die letzten p_tage Tage mit Ads-Daten gegen
-- die p_tage davor, getrennt nach Steuerung (Helium 10 / Pulse). Summiert
-- nur; gerechnet wird in _shared/ads_produkt_lage.ts.
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
  summen as (
    select s.produkt, s.modus,
           case when a.datum > ende.d - t.n then 'aktuell' else 'davor' end as fenster,
           count(distinct a.campaign_id) as kampagnen,
           sum(a.impressions) as impressions, sum(a.clicks) as clicks,
           sum(a.spend_cents) as spend_cents, sum(a.sales_cents) as sales_cents, sum(a.orders) as orders
      from public.ads_steuerung s
      cross join ende cross join t
      join public.ads_daily a on a.tenant_id = s.tenant_id and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz
                             and a.datum > ende.d - 2 * t.n and a.datum <= ende.d
     where s.tenant_id = p_tenant and s.modus <> 'nur_analyse' and s.produkt is not null
     group by 1, 2, 3
  ),
  -- Kampagnentage mit leerem Budget in den letzten p_tage Kalendertagen. Der
  -- Vortagesstand kurz nach Mitternacht zaehlt nicht (wie in ads_budget_tage).
  leer as (
    select s.produkt, count(distinct (b.campaign_id, (b.gemessen_am at time zone 'Europe/Berlin')::date)) as kampagnentage
      from public.ads_steuerung s cross join t
      join public.ads_budget_auslastung b on b.tenant_id = s.tenant_id and b.campaign_id = s.campaign_id
                                         and b.marktplatz = p_marktplatz
     where s.tenant_id = p_tenant and s.modus <> 'nur_analyse' and s.produkt is not null
       and b.auslastung_prozent >= 100
       and b.gemessen_am > now() - make_interval(days => t.n)
       and (b.amazon_stand at time zone 'Europe/Berlin')::date = (b.gemessen_am at time zone 'Europe/Berlin')::date
     group by 1
  )
  select jsonb_build_object(
    'letzter_tag', (select d from ende),
    'tage', (select n from t),
    'zeilen', coalesce((select jsonb_agg(to_jsonb(summen)) from summen), '[]'::jsonb),
    'budget_leer', coalesce((select jsonb_object_agg(produkt, kampagnentage) from leer), '{}'::jsonb)
  );
$function$;

revoke all on function public.ads_produkt_lage(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.ads_produkt_lage(uuid, text, integer) to service_role;
notify pgrst, 'reload schema';

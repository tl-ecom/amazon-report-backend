-- Wohin gehoert ein geernteter Suchbegriff? Liefert die laufenden
-- Anzeigengruppen mit aktiven Exact-Keywords samt den ASINs, die sie im
-- Zeitraum beworben haben. Die Auswahl selbst trifft _shared/ads_kandidaten.ts.
create or replace function public.ads_exact_gruppen(
  p_tenant uuid, p_marktplatz text, p_von date, p_bis date
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with stand as (
    select max(gesehen_am) as s from public.ads_kampagnen
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  gruppen_asins as (
    select ad_group_id, array_agg(distinct asin) as asins
      from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
       and datum between p_von and p_bis and asin <> '' and impressions > 0
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'campaign_id', x.campaign_id, 'campaign_name', x.campaign_name,
           'ad_group_id', x.ad_group_id, 'exact_keywords', x.n,
           'asins', coalesce(to_jsonb(ga.asins), '[]'::jsonb))), '[]'::jsonb)
    from (
      select k.campaign_id, k.name as campaign_name, g.ad_group_id, count(*) as n
        from stand
        join public.ads_kampagnen k on k.tenant_id = p_tenant and k.marktplatz = p_marktplatz
                                   and k.gesehen_am = stand.s and k.state = 'ENABLED'
        join public.ads_anzeigengruppen g on g.tenant_id = p_tenant and g.campaign_id = k.campaign_id
                                         and g.gesehen_am = stand.s and g.state = 'ENABLED'
        join public.ads_ziele z on z.tenant_id = p_tenant and z.ad_group_id = g.ad_group_id
                               and z.gesehen_am = stand.s and z.art = 'keyword'
                               and z.match_type = 'EXACT' and z.state = 'ENABLED'
       group by 1, 2, 3
    ) x
    left join gruppen_asins ga using (ad_group_id);
$function$;

revoke all on function public.ads_exact_gruppen(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.ads_exact_gruppen(uuid, text, date, date) to service_role;
notify pgrst, 'reload schema';

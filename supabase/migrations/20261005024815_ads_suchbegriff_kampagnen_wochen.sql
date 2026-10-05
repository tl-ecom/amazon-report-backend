-- Aus welcher Kampagne kamen die Werbeklicks eines Suchbegriffs, Woche fuer
-- Woche? Ergaenzt den Kaufanteil je Suchbegriff (_shared/sqp_produkt.ts):
-- faellt ein Begriff, zeigt das, WELCHE Kampagne die Klicks verloren hat.
--
-- Nur gesteuerte Kampagnen (ads_steuerung), nur Sponsored Products — mehr
-- kennt ads_suchbegriffe_daily nicht. Wochen wie in Brand Analytics:
-- p_wochen sind die Wochenanfaenge (Sonntag), eine Woche hat sieben Tage.
create or replace function public.ads_suchbegriff_kampagnen_wochen(
  p_tenant uuid, p_marktplatz text, p_begriffe text[], p_wochen date[]
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with begriffe as (select distinct lower(b) as b from unnest(p_begriffe) b),
  wochen as (select distinct w as von from unnest(p_wochen) w),
  summen as (
    select s.produkt, s.modus, a.campaign_id, max(a.campaign_name) as campaign_name,
           lower(a.suchbegriff) as begriff, w.von,
           sum(a.clicks) as klicks, sum(a.orders) as bestellungen, sum(a.spend_cents) as spend_cents
      from public.ads_steuerung s
      join public.ads_suchbegriffe_daily a on a.tenant_id = s.tenant_id and a.campaign_id = s.campaign_id
                                          and a.marktplatz = p_marktplatz
      join begriffe b on b.b = lower(a.suchbegriff)
      join wochen w on a.datum between w.von and w.von + 6
     where s.tenant_id = p_tenant and s.modus <> 'nur_analyse' and s.produkt is not null
     group by 1, 2, 3, 5, 6
    having sum(a.clicks) > 0
  )
  select coalesce(jsonb_agg(to_jsonb(summen)), '[]'::jsonb) from summen;
$function$;

revoke all on function public.ads_suchbegriff_kampagnen_wochen(uuid, text, text[], date[]) from public, anon, authenticated;
grant execute on function public.ads_suchbegriff_kampagnen_wochen(uuid, text, text[], date[]) to service_role;
notify pgrst, 'reload schema';

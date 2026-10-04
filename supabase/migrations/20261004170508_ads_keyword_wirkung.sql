-- Wirkung neu angelegter Keywords und Targets: was haben sie seit dem Anlegen
-- gebracht, und was lief ueber denselben Suchbegriff davor und daneben.
--
-- WOHER DAS ANLAGEDATUM KOMMT (zwei Quellen, die bessere gewinnt):
--   pulse_log  ads_aenderungen_log, aktion keyword_anlegen: sekundengenau, aber
--              nur fuer Keywords, die ueber Pulse angelegt wurden.
--   snapshot   ads_ziele.erstmals_gesehen: jeder Weg, auch die Amazon-Konsole,
--              aber nur auf einen Tag genau und erst seit dem 04.10.2026.
--
-- DREI FENSTER GLEICHER LAENGE (hoechstens 30 Tage, sonst so viele, wie seit
-- dem Anlegen Daten vorliegen):
--   eigen     das neue Ziel selbst, ab Anlagetag           (ads_ziele_daily)
--   vorher    derselbe Suchbegriff ueber ANDERE Ziele davor (ads_suchbegriffe_daily)
--   anderswo  derselbe Suchbegriff ueber andere Ziele seither
--
-- vorher/anderswo gibt es nur, wo "derselbe Suchbegriff" eindeutig ist: bei
-- Exact-Keywords und ASIN-Targets. Ein Phrase- oder Broad-Keyword faengt viele
-- Begriffe — ein Vergleich mit genau einem waere erfunden.
--
-- LETZTER TAG: der fruehere der beiden Datenstaende. Die Berichte hinken
-- unterschiedlich nach; ein Fenster, das in einen davon hineinragt, in dem noch
-- nichts steht, saehe aus wie ein Einbruch.
create or replace function public.ads_keyword_wirkung(
  p_tenant uuid,
  p_marktplatz text,
  p_von date,
  p_bis date
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with stand as (
    select least(
      (select max(datum) from public.ads_ziele_daily
        where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP'),
      (select max(datum) from public.ads_suchbegriffe_daily
        where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP')
    ) as letzter_tag
  ),
  neu as (
    select z.ziel_id, z.art, z.text, z.match_type, z.state, z.gebot_cents,
           z.campaign_id, z.ad_group_id,
           coalesce(l.am, z.erstmals_gesehen) as angelegt,
           case when l.am is not null then 'pulse_log' else 'snapshot' end as quelle,
           case when z.art = 'keyword' and z.match_type = 'EXACT' then lower(z.text)
                when z.art = 'target' then lower(substring(z.text from '[Bb]0[A-Za-z0-9]{8}'))
           end as begriff
      from public.ads_ziele z
      left join lateral (
        select min(a.created_at) as am from public.ads_aenderungen_log a
         where a.tenant_id = p_tenant and a.aktion = 'keyword_anlegen'
           and a.ergebnis = 'ok' and a.objekt_id = z.ziel_id
      ) l on true
     where z.tenant_id = p_tenant and z.marktplatz = p_marktplatz
       and z.art in ('keyword', 'target')
       and coalesce(l.am, z.erstmals_gesehen)::date between p_von and p_bis
  ),
  f as (
    select n.*, n.angelegt::date as d,
           greatest(0, least(30, (select letzter_tag from stand) - n.angelegt::date + 1)) as tage
      from neu n
  )
  select jsonb_build_object(
    'letzter_tag', (select letzter_tag from stand),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ziel_id', f.ziel_id, 'art', f.art, 'text', f.text, 'match_type', f.match_type,
        'state', f.state, 'gebot_cents', f.gebot_cents,
        'campaign_id', f.campaign_id,
        'campaign_name', (select k.name from public.ads_kampagnen k
                           where k.tenant_id = p_tenant and k.marktplatz = p_marktplatz
                             and k.campaign_id = f.campaign_id),
        'angelegt', f.angelegt, 'quelle', f.quelle, 'tage', f.tage, 'begriff', f.begriff,
        'eigen', (
          select jsonb_build_object(
                   'clicks', coalesce(sum(d.clicks), 0), 'spend_cents', coalesce(sum(d.spend_cents), 0),
                   'sales_cents', coalesce(sum(d.sales_cents), 0), 'orders', coalesce(sum(d.orders), 0))
            from public.ads_ziele_daily d
           where d.tenant_id = p_tenant and d.marktplatz = p_marktplatz and d.ziel_id = f.ziel_id
             and d.datum between f.d and f.d + f.tage - 1
        ),
        'vorher', case when f.begriff is null or f.tage = 0 then null else (
          select jsonb_build_object(
                   'clicks', coalesce(sum(s.clicks), 0), 'spend_cents', coalesce(sum(s.spend_cents), 0),
                   'sales_cents', coalesce(sum(s.sales_cents), 0), 'orders', coalesce(sum(s.orders), 0))
            from public.ads_suchbegriffe_daily s
           where s.tenant_id = p_tenant and s.marktplatz = p_marktplatz and s.ad_product = 'SP'
             and lower(s.suchbegriff) = f.begriff and s.ziel_id <> f.ziel_id
             and s.datum between f.d - f.tage and f.d - 1
        ) end,
        'anderswo', case when f.begriff is null or f.tage = 0 then null else (
          select jsonb_build_object(
                   'clicks', coalesce(sum(s.clicks), 0), 'spend_cents', coalesce(sum(s.spend_cents), 0),
                   'sales_cents', coalesce(sum(s.sales_cents), 0), 'orders', coalesce(sum(s.orders), 0))
            from public.ads_suchbegriffe_daily s
           where s.tenant_id = p_tenant and s.marktplatz = p_marktplatz and s.ad_product = 'SP'
             and lower(s.suchbegriff) = f.begriff and s.ziel_id <> f.ziel_id
             and s.datum between f.d and f.d + f.tage - 1
        ) end
      ) order by f.angelegt desc)
      from f
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_keyword_wirkung(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.ads_keyword_wirkung(uuid, text, date, date) to service_role;

notify pgrst, 'reload schema';

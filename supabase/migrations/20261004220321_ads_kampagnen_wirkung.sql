-- Wirkung von Budget- und Platzierungsaenderungen je Kampagne.
--
-- ZWEI QUELLEN fuer die Aenderung, die genauere gewinnt:
--   pulse_log  ads_aenderungen_log (budget_setzen, platzierung_setzen):
--              minutengenau, mit Begruendung, aber nur was ueber Pulse lief.
--   snapshot   ads_struktur_aenderungen: jeder Weg, auch die Amazon-Konsole,
--              aber nur auf das Fenster zwischen zwei Snapshots genau und erst
--              seit dem 04.10.2026.
-- Erscheint dieselbe Aenderung in beiden (Pulse aendert, der naechste Snapshot
-- sieht es), zaehlt nur der Protokolleintrag.
--
-- FENSTER: sieben Tage davor gegen sieben Tage danach, OHNE den Aenderungstag —
-- der ist halb alt, halb neu. Bei Snapshot-Aenderungen faellt zusaetzlich der
-- Tag davor weg, weil die Aenderung irgendwo zwischen zwei Snapshots liegt.
--
-- Bei Platzierungen stehen ZWEI Zahlenpaare da: die ganze Kampagne und die
-- eine Platzierung, deren Aufschlag geaendert wurde. Ein hoeherer Aufschlag auf
-- Top of Search soll dort mehr bringen — ob er es tat, sieht man nur dort.
--
-- Amazons Platzierungsnamen im Bericht weichen von denen der Einstellung ab:
--   PLACEMENT_TOP             -> Top of Search on-Amazon
--   PLACEMENT_PRODUCT_PAGE    -> Detail Page on-Amazon
--   PLACEMENT_REST_OF_SEARCH  -> Other on-Amazon
create or replace function public.ads_kampagnen_wirkung(
  p_tenant uuid,
  p_marktplatz text,
  p_von date,
  p_bis date
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with kamp as (
    select campaign_id, name from public.ads_kampagnen
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  log_roh as (
    select l.campaign_id, l.aktion, l.created_at, l.grund, l.vorher, l.nachher
      from public.ads_aenderungen_log l
      join kamp k on k.campaign_id = l.campaign_id
     where l.tenant_id = p_tenant and l.ergebnis = 'ok'
       and l.aktion in ('budget_setzen', 'platzierung_setzen')
  ),
  log_ev as (
    select campaign_id, 'budget'::text as feld, null::text as platzierung,
           (vorher ->> 'budget')::numeric as vorher, (nachher ->> 'budget')::numeric as nachher,
           created_at as am, null::timestamptz as fenster_ab, 'pulse_log'::text as quelle, grund
      from log_roh where aktion = 'budget_setzen'
    union all
    select r.campaign_id,
           case n ->> 'placement' when 'PLACEMENT_TOP' then 'mod_top'
                                  when 'PLACEMENT_PRODUCT_PAGE' then 'mod_produktseite'
                                  else 'mod_rest' end,
           case n ->> 'placement' when 'PLACEMENT_TOP' then 'Top of Search on-Amazon'
                                  when 'PLACEMENT_PRODUCT_PAGE' then 'Detail Page on-Amazon'
                                  else 'Other on-Amazon' end,
           coalesce((select (v ->> 'percentage')::numeric
                       from jsonb_array_elements(coalesce(r.vorher -> 'placementBidding', '[]'::jsonb)) v
                      where v ->> 'placement' = n ->> 'placement' limit 1), 0),
           (n ->> 'percentage')::numeric,
           r.created_at, null::timestamptz, 'pulse_log', r.grund
      from log_roh r, jsonb_array_elements(coalesce(r.nachher -> 'placementBidding', '[]'::jsonb)) n
     where r.aktion = 'platzierung_setzen'
  ),
  snap_ev as (
    select s.objekt_id as campaign_id,
           case s.feld when 'budget_cents' then 'budget' when 'mod_top_prozent' then 'mod_top'
                       when 'mod_produktseite_prozent' then 'mod_produktseite' else 'mod_rest' end as feld,
           case s.feld when 'mod_top_prozent' then 'Top of Search on-Amazon'
                       when 'mod_produktseite_prozent' then 'Detail Page on-Amazon'
                       when 'mod_rest_prozent' then 'Other on-Amazon' end as platzierung,
           -- Budget liegt in Cent; ein fehlender Aufschlag ist 0 % (Amazon laesst ihn weg).
           case when s.feld = 'budget_cents' then s.vorher::numeric / 100 else coalesce(s.vorher::numeric, 0) end as vorher,
           case when s.feld = 'budget_cents' then s.nachher::numeric / 100 else coalesce(s.nachher::numeric, 0) end as nachher,
           s.erkannt_am as am, s.stand_vorher as fenster_ab, 'snapshot'::text as quelle, null::text as grund
      from public.ads_struktur_aenderungen s
     where s.tenant_id = p_tenant and s.marktplatz = p_marktplatz and s.ebene = 'kampagne'
       and s.feld in ('budget_cents', 'mod_top_prozent', 'mod_produktseite_prozent', 'mod_rest_prozent')
       and not exists (
         select 1 from log_ev l
          where l.campaign_id = s.objekt_id
            and l.feld = case s.feld when 'budget_cents' then 'budget' when 'mod_top_prozent' then 'mod_top'
                                     when 'mod_produktseite_prozent' then 'mod_produktseite' else 'mod_rest' end
            and l.am > coalesce(s.stand_vorher, s.erkannt_am - interval '2 days') and l.am <= s.erkannt_am
       )
  ),
  ev as (
    select e.*, (e.am at time zone 'Europe/Berlin')::date as d,
           coalesce((e.fenster_ab at time zone 'Europe/Berlin')::date, (e.am at time zone 'Europe/Berlin')::date) - 1 as vor_ende,
           (e.am at time zone 'Europe/Berlin')::date + 1 as nach_start
      from (select * from log_ev union all select * from snap_ev) e
     where e.vorher is distinct from e.nachher
  ),
  f as (
    select * from ev where d between p_von and p_bis
  ),
  stand as (
    select max(datum) as letzter_tag from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP'
  )
  select jsonb_build_object(
    'letzter_tag', (select letzter_tag from stand),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign_id', f.campaign_id, 'campaign_name', k.name,
        'feld', f.feld, 'platzierung', f.platzierung,
        'vorher', f.vorher, 'nachher', f.nachher,
        'am', f.am, 'fenster_ab', f.fenster_ab, 'quelle', f.quelle, 'grund', f.grund,
        'nachlauf_vollstaendig', ((select letzter_tag from stand) >= f.nach_start + 6),
        'davor', (
          select jsonb_build_object('clicks', coalesce(sum(a.clicks), 0), 'spend_cents', coalesce(sum(a.spend_cents), 0),
                                    'sales_cents', coalesce(sum(a.sales_cents), 0), 'orders', coalesce(sum(a.orders), 0))
            from public.ads_daily a
           where a.tenant_id = p_tenant and a.marktplatz = p_marktplatz and a.ad_product = 'SP'
             and a.campaign_id = f.campaign_id and a.datum between f.vor_ende - 6 and f.vor_ende),
        'danach', (
          select jsonb_build_object('clicks', coalesce(sum(a.clicks), 0), 'spend_cents', coalesce(sum(a.spend_cents), 0),
                                    'sales_cents', coalesce(sum(a.sales_cents), 0), 'orders', coalesce(sum(a.orders), 0))
            from public.ads_daily a
           where a.tenant_id = p_tenant and a.marktplatz = p_marktplatz and a.ad_product = 'SP'
             and a.campaign_id = f.campaign_id and a.datum between f.nach_start and f.nach_start + 6),
        'platz_davor', case when f.platzierung is null then null else (
          select jsonb_build_object('clicks', coalesce(sum(a.clicks), 0), 'spend_cents', coalesce(sum(a.spend_cents), 0),
                                    'sales_cents', coalesce(sum(a.sales_cents), 0), 'orders', coalesce(sum(a.orders), 0))
            from public.ads_placement_daily a
           where a.tenant_id = p_tenant and a.marktplatz = p_marktplatz and a.ad_product = 'SP'
             and a.campaign_id = f.campaign_id and a.platzierung = f.platzierung
             and a.datum between f.vor_ende - 6 and f.vor_ende) end,
        'platz_danach', case when f.platzierung is null then null else (
          select jsonb_build_object('clicks', coalesce(sum(a.clicks), 0), 'spend_cents', coalesce(sum(a.spend_cents), 0),
                                    'sales_cents', coalesce(sum(a.sales_cents), 0), 'orders', coalesce(sum(a.orders), 0))
            from public.ads_placement_daily a
           where a.tenant_id = p_tenant and a.marktplatz = p_marktplatz and a.ad_product = 'SP'
             and a.campaign_id = f.campaign_id and a.platzierung = f.platzierung
             and a.datum between f.nach_start and f.nach_start + 6) end
      ) order by f.am desc)
      from f left join kamp k on k.campaign_id = f.campaign_id
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_kampagnen_wirkung(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.ads_kampagnen_wirkung(uuid, text, date, date) to service_role;

notify pgrst, 'reload schema';

-- Kurz nach Mitternacht meldet Amazons Budget-Usage-API noch den Stand des
-- Vortags: Auslastung 100 %, Stempel von gestern Abend. Die Messung um 00:20
-- zaehlte das als neuen Tag mit leerem Budget — am 05.10.2026 standen dadurch
-- sieben Kampagnen "seit gestern 17:52" leer, obwohl ihr Budget um Mitternacht
-- zurueckgesetzt war und nur noch nichts ausgegeben hatte.
--
-- Eine Messung zaehlt deshalb nur, wenn Amazons Stempel vom SELBEN Tag stammt
-- wie die Messung. Ein Stempel vom Vortag heisst: heute noch keine Bewegung.
create or replace function public.ads_budget_tage(
  p_tenant uuid,
  p_marktplatz text,
  p_von date,
  p_bis date
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with m as (
    select a.*, (a.gemessen_am at time zone 'Europe/Berlin')::date as tag
      from public.ads_budget_auslastung a
     where a.tenant_id = p_tenant and a.marktplatz = p_marktplatz
       and a.gemessen_am >= (p_von::timestamp at time zone 'Europe/Berlin')
       and a.gemessen_am <  ((p_bis + 1)::timestamp at time zone 'Europe/Berlin')
       and (a.amazon_stand is null
            or (a.amazon_stand at time zone 'Europe/Berlin')::date = (a.gemessen_am at time zone 'Europe/Berlin')::date)
  ),
  je as (
    select m.tag, m.campaign_id,
           max(m.auslastung_prozent) as hoechste,
           count(*) filter (where m.auslastung_prozent >= 100) as n_voll,
           count(*) as n_ab_schwelle,
           -- Stempel der ERSTEN Messung mit 100 %: da lief sie spaetestens leer.
           (array_agg(m.amazon_stand order by m.gemessen_am) filter (where m.auslastung_prozent >= 100))[1] as voll_seit,
           -- Stempel der LETZTEN Messung: seither hat sich nichts mehr bewegt.
           (array_agg(m.amazon_stand order by m.gemessen_am desc))[1] as letzte_bewegung,
           max(m.gemessen_am) as zuletzt_gemessen,
           (array_agg(m.budget_cents order by m.gemessen_am desc))[1] as budget_cents
      from m group by m.tag, m.campaign_id
  ),
  laeufe as (
    select (rj.completed_at at time zone 'Europe/Berlin')::date as tag, count(*) as n
      from public.report_jobs rj
     where rj.tenant_id = p_tenant and rj.source = 'ads' and rj.report_type = 'sp-budget-auslastung'
       and rj.status = 'DONE' and rj.config ->> 'marktplatz' = p_marktplatz
       and rj.completed_at >= (p_von::timestamp at time zone 'Europe/Berlin')
       and rj.completed_at <  ((p_bis + 1)::timestamp at time zone 'Europe/Berlin')
     group by 1
  )
  select jsonb_build_object(
    'erste_messung', (select min(completed_at) from public.report_jobs
                       where tenant_id = p_tenant and source = 'ads' and report_type = 'sp-budget-auslastung'
                         and status = 'DONE' and config ->> 'marktplatz' = p_marktplatz),
    'messungen_je_tag', coalesce((select jsonb_object_agg(tag::text, n) from laeufe), '{}'::jsonb),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tag', je.tag, 'campaign_id', je.campaign_id,
        'campaign_name', k.name,
        'hoechste', je.hoechste, 'n_voll', je.n_voll, 'n_ab_schwelle', je.n_ab_schwelle,
        'voll_seit', je.voll_seit, 'letzte_bewegung', je.letzte_bewegung,
        'zuletzt_gemessen', je.zuletzt_gemessen, 'budget_cents', je.budget_cents,
        'tagesende', ((je.tag + 1)::timestamp at time zone 'Europe/Berlin')
      ) order by je.tag desc, je.hoechste desc)
      from je
      left join public.ads_kampagnen k
        on k.tenant_id = p_tenant and k.marktplatz = p_marktplatz and k.campaign_id = je.campaign_id
    ), '[]'::jsonb)
  );
$function$;

notify pgrst, 'reload schema';

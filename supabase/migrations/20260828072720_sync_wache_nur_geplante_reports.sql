-- Die Wache meldete jeden FATAL — auch von Report-Typen, die gar nicht im
-- Zeitplan stehen und nur von Hand angestossen wurden.
--
-- Konkret am 27.08.: Ich habe GET_FBA_INVENTORY_AGED_DATA dreimal testweise
-- angefordert, um zu klaeren, ob er noch funktioniert (er tut es nicht, und
-- Amazon nennt keinen Grund). Am naechsten Morgen kam dafuer eine
-- Stoerungsmeldung — fuer einen Report, der in keinem Zeitplan steht, den
-- niemand erwartet und dessen Ausfall keine Folgen hat.
--
-- Fehlalarme sind teuer: Nach dem dritten oeffnet man die Mail nicht mehr, und
-- dann faellt auch die echte Stoerung nicht mehr auf. Deshalb meldet die Wache
-- ab jetzt nur noch, was in internal.scheduler_reports aktiv ist. Ein
-- Handversuch mit einem nicht eingeplanten Report ist ein Experiment, keine
-- Stoerung.
--
-- Die Regel "nur Fehlschlaege OHNE erfolgreichen Nachlauf" bleibt bestehen.

create or replace function public.sync_stoerungen(p_max_alter interval DEFAULT '36:00:00'::interval)
returns table(mandant text, quelle text, art text, detail text)
language sql stable security definer set search_path to 'public'
as $function$
  with verbindungen as (
    select ac.tenant_id, ac.source, t.name
    from public.auth_contexts ac
    join public.tenants t on t.id = ac.tenant_id
    where ac.status = 'connected' and t.status = 'active'
  ),
  letzter as (
    select v.tenant_id, v.source, v.name,
           max(rj.completed_at) filter (where rj.status = 'DONE') as erfolg
    from verbindungen v
    left join public.report_jobs rj
      on rj.tenant_id = v.tenant_id and rj.source = v.source
    group by v.tenant_id, v.source, v.name
  ),
  -- Fehlschlaege, die NICHT nachtraeglich gutgegangen sind — und nur bei
  -- Report-Typen, die ueberhaupt planmaessig laufen sollen.
  offen as (
    select v.name, v.source, rj.report_type, rj.error_detail, rj.created_at
    from verbindungen v
    join public.report_jobs rj
      on rj.tenant_id = v.tenant_id and rj.source = v.source
    where rj.status = 'FATAL'
      and rj.created_at > now() - interval '24 hours'
      and (
        -- Ads laeuft ueber einen eigenen Weg und steht nicht in scheduler_reports.
        rj.source <> 'sp'
        or exists (
          select 1 from internal.scheduler_reports sr
          where sr.report_type = rj.report_type and sr.aktiv
        )
      )
      and not exists (
        select 1 from public.report_jobs ok
        where ok.tenant_id = rj.tenant_id
          and ok.report_type = rj.report_type
          and ok.status = 'DONE'
          and ok.created_at > rj.created_at
      )
  )
  -- 1. Zu lange kein erfolgreicher Lauf. Der Fall, der elf Tage unbemerkt
  --    blieb: nichts schlaegt fehl, es passiert nur nichts mehr.
  select l.name, l.source, 'kein Erfolg',
         case when l.erfolg is null
              then 'noch nie erfolgreich gelaufen'
              else 'letzter Erfolg vor ' || date_trunc('minute', now() - l.erfolg)::text
         end
  from letzter l
  where l.erfolg is null or l.erfolg < now() - p_max_alter

  union all

  -- 2. Fehlschlaege, die offen geblieben sind. Der Report-Typ steht dabei —
  --    ohne ihn musste man jedes Mal selbst in der Datenbank nachsehen.
  select o.name, o.source, 'fehlgeschlagen',
         count(*)::text || ' Job(s) ohne Nachlauf: '
           || string_agg(distinct o.report_type, ', ')
           || ' (' || coalesce(max(o.error_detail), 'ohne Meldung') || ')'
  from offen o
  group by o.name, o.source
$function$;

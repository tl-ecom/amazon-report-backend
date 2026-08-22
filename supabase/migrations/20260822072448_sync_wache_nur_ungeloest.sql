-- Die Wache meldete jeden FATAL der letzten 24 h — auch wenn der Report danach
-- erfolgreich nachlief. Mit den Nachlaeufen waere das der Regelfall geworden:
-- taegliche Mails ueber Probleme, die sich selbst erledigt haben. Fehlalarme
-- sind teuer, weil man die Mail nach dem dritten Mal nicht mehr oeffnet.
--
-- Neu: Ein Fehlschlag wird nur gemeldet, wenn fuer denselben Report seit dem
-- Fehlschlag KEIN erfolgreicher Lauf mehr kam. Was sich von selbst behoben hat,
-- ist keine Stoerung.
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
  -- Fehlschlaege, die NICHT nachtraeglich gutgegangen sind.
  offen as (
    select v.name, v.source, rj.report_type, rj.error_detail, rj.created_at
    from verbindungen v
    join public.report_jobs rj
      on rj.tenant_id = v.tenant_id and rj.source = v.source
    where rj.status = 'FATAL'
      and rj.created_at > now() - interval '24 hours'
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
$function$;;

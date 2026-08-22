-- Amazon liefert bei manchen Reports sprunghaft FATAL. Beim FBA-Bestandsbericht
-- waren es 9 von 14 Tagen, in Bloecken — kein dauerhafter Defekt, sondern
-- Aussetzer. Bisher gab es EINEN Versuch pro Tag: schlug er fehl, fehlten die
-- Bestandsdaten den ganzen Tag, und Nachschub/Ladenhueter/Lagerkosten rechneten
-- auf dem Stand vom Vortag. Gemeldet wurde es, behoben nicht.
--
-- Diese Funktion stoesst alles erneut an, was heute noch keinen erfolgreichen
-- Lauf hat — egal ob FATAL, CANCELLED oder nie gestartet. Sie ist idempotent:
-- was schon DONE ist, wird uebersprungen.
create or replace function internal.cron_sync_nachzuegler()
returns integer
language plpgsql security definer set search_path to 'internal', 'public'
as $$
declare
  r record;
  angestossen integer := 0;
begin
  for r in
    select ac.tenant_id, sr.report_type, sr.days
    from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    cross join internal.scheduler_reports sr
    where ac.source = 'sp'
      and ac.status = 'connected'
      and tn.status = 'active'
      and sr.aktiv
      -- Nur, was heute noch nicht geklappt hat.
      and not exists (
        select 1 from public.report_jobs rj
        where rj.tenant_id = ac.tenant_id
          and rj.report_type = sr.report_type
          and rj.status = 'DONE'
          and rj.created_at >= date_trunc('day', now())
      )
    order by ac.tenant_id, sr.report_type
  loop
    begin
      perform internal.stosse_sync_an(
        r.tenant_id,
        jsonb_build_object('report_type', r.report_type, 'days', r.days)
      );
      angestossen := angestossen + 1;
    exception when others then
      raise warning 'Nachzuegler % / %: %', r.tenant_id, r.report_type, sqlerrm;
    end;
  end loop;
  return angestossen;
end $$;

-- Zwei Nachläufe mit Abstand: Amazons Aussetzer dauern oft nur Minuten, manchmal
-- Stunden. Der Hauptlauf ist 04:30.
select cron.schedule('sync-nachzuegler-vormittag', '30 8 * * *',
                     'select internal.cron_sync_nachzuegler()');
select cron.schedule('sync-nachzuegler-nachmittag', '30 13 * * *',
                     'select internal.cron_sync_nachzuegler()');;

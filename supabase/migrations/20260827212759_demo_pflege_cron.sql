-- Taegliche Pflege des Demo-Mandanten: erst die Zeitachse fortschreiben, dann
-- die Report-Momentaufnahmen daraus neu bauen. Reihenfolge ist wesentlich —
-- die Reports lesen die Verlaufsdaten, die der erste Schritt gerade ergaenzt hat.
--
-- 05:00 UTC: nach dem echten Report-Sync (04:30), damit beide sich nicht um
-- Verbindungen streiten, und vor dem Arbeitstag.

create or replace function internal.cron_demo_pflege()
returns jsonb
language plpgsql
security definer
set search_path to 'internal', 'public'
as $$
declare
  v_zeit jsonb;
  v_rep  jsonb;
begin
  v_zeit := internal.demo_zeitachse_fortschreiben();
  v_rep  := internal.demo_reports_erzeugen();
  return jsonb_build_object('zeitachse', v_zeit, 'reports', v_rep);
end $$;

revoke all on function internal.cron_demo_pflege() from public, anon, authenticated;

select cron.unschedule('demo-pflege-taeglich')
where exists (select 1 from cron.job where jobname = 'demo-pflege-taeglich');
select cron.schedule('demo-pflege-taeglich', '0 5 * * *', 'select internal.cron_demo_pflege()');;

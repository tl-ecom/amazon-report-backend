-- Sync-Wache — meldet ausgefallene Syncs, statt sie still liegen zu lassen.
--
-- Anlass: Vom 6. bis 17.8.2026 wurde kein einziger Ads-Job mehr fertig. Elf Tage
-- lang, ohne dass es irgendwo als Fehler auftauchte. Die Jobs standen auf
-- PROCESSING, und dort schaut niemand nach. Der Fix vom 17.8. macht solche Faelle
-- nach 6 Stunden als FATAL sichtbar — aber sichtbar heisst nicht bemerkt.
--
-- sync_stoerungen() ist bewusst eine eigene, lesbare Funktion: Man kann jederzeit
-- `select * from public.sync_stoerungen();` aufrufen und sieht denselben Stand,
-- den auch die Meldung verschickt. Eine Wache, deren Urteil man nicht nachpruefen
-- kann, ist keine.
--
-- Schwelle 36 h: Die Syncs laufen taeglich gegen 04:30, der letzte Erfolg ist im
-- Normalbetrieb also 0-24 h alt. 36 h schlaegt an, sobald ein Tageslauf komplett
-- ausfaellt — der Ads-Ausfall waere damit an Tag zwei aufgefallen statt nach elf.

create or replace function public.sync_stoerungen(p_max_alter interval default '36 hours')
returns table (mandant text, quelle text, art text, detail text)
language sql
stable
security definer
set search_path to 'public'
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
  )
  -- 1. Zu lange kein erfolgreicher Lauf. Das ist der Fall, der elf Tage
  --    unbemerkt blieb: nichts schlaegt fehl, es passiert nur nichts mehr.
  select l.name, l.source, 'kein Erfolg',
         case when l.erfolg is null
              then 'noch nie erfolgreich gelaufen'
              else 'letzter Erfolg vor ' || date_trunc('minute', now() - l.erfolg)::text
         end
  from letzter l
  where l.erfolg is null or l.erfolg < now() - p_max_alter

  union all

  -- 2. Ausdrueckliche Fehlschlaege seit gestern.
  select v.name, v.source, 'fehlgeschlagen',
         count(*)::text || ' Job(s) auf FATAL, zuletzt: '
           || coalesce(max(rj.error_detail), 'ohne Meldung')
  from verbindungen v
  join public.report_jobs rj
    on rj.tenant_id = v.tenant_id and rj.source = v.source
  where rj.status = 'FATAL' and rj.created_at > now() - interval '24 hours'
  group by v.name, v.source
$function$;

comment on function public.sync_stoerungen(interval) is
  'Ausgefallene oder fehlgeschlagene Syncs je Mandant und Quelle. Zwei Arten: kein Erfolg seit p_max_alter (Standard 36h — ein ausgefallener Tageslauf), und FATAL-Jobs der letzten 24h. Jederzeit direkt aufrufbar.';

create or replace function internal.cron_sync_wache()
returns integer
language plpgsql
security definer
set search_path to 'internal', 'public', 'net'
as $function$
declare
  r       record;
  zeilen  text := '';
  anzahl  integer := 0;
  url     text;
begin
  for r in select * from public.sync_stoerungen() loop
    zeilen := zeilen || format('- %s / %s: %s (%s)', r.mandant, r.quelle, r.art, r.detail) || chr(10);
    anzahl := anzahl + 1;
  end loop;

  if anzahl = 0 then
    return 0;
  end if;

  -- Ohne hinterlegten Kanal trotzdem melden, nur eben ins Postgres-Log. Sonst
  -- waere die Wache selbst der naechste stille Ausfall.
  begin
    url := internal.vault_secret('slack_webhook_url');
  exception when others then
    url := null;
  end;

  if url is null or url = '' then
    raise warning 'Sync-Wache: % Stoerung(en), aber kein slack_webhook_url im Vault. %', anzahl, zeilen;
    return anzahl;
  end if;

  perform net.http_post(
    url     := url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('text',
                 format('*Operator Pulse — %s Sync-Stoerung(en)*%s%s', anzahl, chr(10), zeilen)),
    timeout_milliseconds := 15000
  );
  return anzahl;
end $function$;

comment on function internal.cron_sync_wache() is
  'Taeglicher Waechter: verschickt sync_stoerungen() an den Slack-Webhook aus dem Vault (slack_webhook_url). Ohne hinterlegten Webhook wird ins Postgres-Log gewarnt statt still zu schweigen.';

revoke all on function public.sync_stoerungen(interval) from public;
grant execute on function public.sync_stoerungen(interval) to service_role;

-- 06:00 UTC: die Syncs laufen 03:30-04:30, die Wiederaufnahme alle 15 min. Bis
-- dahin hat sich alles gesetzt, was sich noch von selbst erholt.
select cron.unschedule('sync-wache-taeglich')
where exists (select 1 from cron.job where jobname = 'sync-wache-taeglich');
select cron.schedule('sync-wache-taeglich', '0 6 * * *', 'select internal.cron_sync_wache()');

notify pgrst, 'reload schema';

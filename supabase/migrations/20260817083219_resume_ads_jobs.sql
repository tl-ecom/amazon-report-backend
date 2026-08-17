-- Wiederaufnahme offener ADS-Reports — schliesst eine stille Datenluecke.
--
-- Befund vom 2026-08-17: Saemtliche Ads-Jobs seit dem 6.8. standen auf
-- PROCESSING und wurden nie fertig. Ursache war NICHT die Ads-Verbindung,
-- sondern diese Zeile in cron_resume_offene_reports:  where source = 'sp'.
--
-- Ablauf des Fehlers: sync-ads-report pollt Amazon hoechstens POLL_BUDGET_MS
-- (90 s) und beendet dann planmaessig mit HTTP 200 — der Rest ist Sache der
-- Wiederaufnahme. Ads-Jobs kamen dort aber gar nicht vor. Folge: nie
-- wiederaufgenommen, nie aufgegeben, kein report_data, keine ads_daily-Zeile.
-- Am 5.8. lief es nur durch, weil Amazon zufaellig in 40 s fertig war.
-- Im Log sichtbar als execution_time_ms 84933 bei einem 90-s-Budget.
--
-- Zwei Aenderungen:
--   1. stosse_ads_sync_an — eigener Anstoss gegen sync-ads-report. sync-report
--      kennt keine Ads-Reports, ein gemeinsamer Endpunkt geht nicht.
--   2. cron_resume_offene_reports deckt jetzt sp UND ads ab, sowohl beim
--      Wiederaufnehmen als auch beim Aufgeben nach 6 Stunden.

create or replace function internal.stosse_ads_sync_an(p_tenant_id uuid, p_body jsonb)
  returns bigint
  language plpgsql
  security definer
  set search_path to 'internal', 'public', 'net'
as $function$
declare
  v_url text := internal.vault_secret('project_url');
  v_key text := internal.vault_secret('service_role_key');
begin
  if v_url is null or v_key is null then
    raise exception 'Vault-Secrets project_url und/oder service_role_key fehlen.';
  end if;

  return net.http_post(
    url     := v_url || '/functions/v1/sync-ads-report',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := p_body || jsonb_build_object('tenant_id', p_tenant_id),
    timeout_milliseconds := 150000
  );
end $function$;

comment on function internal.stosse_ads_sync_an(uuid, jsonb) is
  'Wie stosse_sync_an, aber gegen sync-ads-report. Noetig fuer die Wiederaufnahme offener Ads-Reports.';

create or replace function internal.cron_resume_offene_reports()
  returns integer
  language plpgsql
  security definer
  set search_path to 'internal', 'public'
as $function$
declare
  r           record;
  angestossen integer := 0;
begin
  -- Hoffnungslose Faelle zuerst aufgeben, sonst werden sie ewig weiterprobiert.
  -- Gilt jetzt auch fuer 'ads': Ads-Jobs kamen hier bisher gar nicht vor und
  -- blieben deshalb unbegrenzt auf PROCESSING stehen.
  update public.report_jobs
     set status = 'FATAL',
         error_detail = 'Nach 6 Stunden immer noch PROCESSING — vom Scheduler aufgegeben.',
         completed_at = now()
   where source in ('sp', 'ads')
     and status = 'PROCESSING'
     and created_at < now() - interval '6 hours';

  for r in
    select rj.tenant_id, rj.amazon_report_id, rj.source
    from public.report_jobs rj
    join public.tenants tn on tn.id = rj.tenant_id
    where rj.source in ('sp', 'ads')
      and rj.status = 'PROCESSING'
      and tn.status = 'active'
      -- Frisch angestossene in Ruhe lassen: der laufende Aufruf pollt noch selbst.
      and rj.created_at < now() - interval '5 minutes'
  loop
    begin
      -- Getrennte Endpunkte: sync-report kennt keine Ads-Reports und umgekehrt.
      if r.source = 'ads' then
        perform internal.stosse_ads_sync_an(
          r.tenant_id,
          jsonb_build_object('report_id', r.amazon_report_id)
        );
      else
        perform internal.stosse_sync_an(
          r.tenant_id,
          jsonb_build_object('report_id', r.amazon_report_id)
        );
      end if;
      angestossen := angestossen + 1;
    exception when others then
      raise warning 'Tenant % / Report % (%): Wiederaufnahme fehlgeschlagen: %',
        r.tenant_id, r.amazon_report_id, r.source, sqlerrm;
    end;
  end loop;

  return angestossen;
end $function$;

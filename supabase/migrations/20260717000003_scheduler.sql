-- SCHEDULER — täglich pro Tenant automatisch Reports ziehen (pg_cron + pg_net).
--
-- Ablauf:
--   cron "sync-alle-tenants-taeglich"  → internal.cron_sync_alle_tenants()
--        stößt pro Tenant und Report-Typ EINEN HTTP-Aufruf an sync-report an.
--   cron "resume-offene-reports"       → internal.cron_resume_offene_reports()
--        nimmt Reports wieder auf, die ins Zeitbudget gelaufen sind (PROCESSING).
--
-- WARUM pg_net UND NICHT EINE SAMMEL-FUNCTION: jeder Tenant bekommt einen eigenen,
-- unabhängigen HTTP-Request. Ein toter Token bei Tenant A kann Tenant B damit
-- gar nicht blockieren — die Requests wissen nichts voneinander. Eine Edge
-- Function, die alle Tenants nacheinander abarbeitet, würde dagegen am
-- Wall-Clock-Limit sterben (90s Poll-Budget × N Tenants).
--
-- RATE-LIMITS: unkritisch über Tenants hinweg. Jeder Kunde hat seine EIGENE
-- Amazon-App und sein eigenes Verkäuferkonto ("Weg A"), die SP-API-Limits gelten
-- pro App+Verkäufer und kollidieren daher nicht zwischen Tenants. Innerhalb eines
-- Tenants werden 2 Report-Typen angestoßen — createReport erlaubt einen Burst
-- von 15, das reicht dafür locker.
--
-- SECRETS: project_url und service_role_key kommen aus dem Vault und stehen
-- NICHT in dieser Datei (Prinzip: keine Geheimnisse im Repo). Sie müssen EINMAL
-- von Hand angelegt werden, siehe UEBERGABE.md. Ohne sie wirft die Funktion
-- einen klaren Fehler, statt still nichts zu tun.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Eigenes Schema: alles hier drin ist NICHT über PostgREST erreichbar.
-- Läge cron_sync_alle_tenants() in public, könnte jeder mit gültigem JWT den
-- Sync per RPC auslösen.
create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated;

-- Welche Report-Typen der tägliche Lauf zieht, und mit welchem Zeitfenster.
-- days=30 für beide: Orders erlaubt maximal 30 (Amazon lehnt mehr nicht ab,
-- sondern liefert eine Fehlermeldung als Report-Inhalt — siehe UEBERGABE.md).
create table if not exists internal.scheduler_reports (
  report_type text primary key,
  days        integer not null default 30 check (days between 1 and 90),
  aktiv       boolean not null default true
);

insert into internal.scheduler_reports (report_type, days) values
  ('GET_SALES_AND_TRAFFIC_REPORT', 30),
  ('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', 30)
on conflict (report_type) do nothing;

-- Liest ein Vault-Secret. security definer, weil pg_cron als Job-Eigentümer läuft.
create or replace function internal.vault_secret(p_name text)
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name
$$;

revoke all on function internal.vault_secret(text) from public, anon, authenticated;

-- Stößt sync-report für einen Tenant an. Gibt die pg_net-Request-ID zurück.
create or replace function internal.stosse_sync_an(
  p_tenant_id   uuid,
  p_body        jsonb
)
returns bigint
language plpgsql
security definer
set search_path = internal, public, net
as $$
declare
  v_url text := internal.vault_secret('project_url');
  v_key text := internal.vault_secret('service_role_key');
begin
  if v_url is null or v_key is null then
    raise exception 'Vault-Secrets project_url und/oder service_role_key fehlen — siehe UEBERGABE.md, Abschnitt Scheduler.';
  end if;

  return net.http_post(
    url     := v_url || '/functions/v1/sync-report',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := p_body || jsonb_build_object('tenant_id', p_tenant_id),
    timeout_milliseconds := 150000
  );
end $$;

revoke all on function internal.stosse_sync_an(uuid, jsonb) from public, anon, authenticated;

-- ---- Täglicher Lauf ----
create or replace function internal.cron_sync_alle_tenants()
returns integer
language plpgsql
security definer
set search_path = internal, public
as $$
declare
  r          record;
  angestossen integer := 0;
begin
  for r in
    select ac.tenant_id, sr.report_type, sr.days
    from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    cross join internal.scheduler_reports sr
    where ac.source = 'sp'
      and ac.status = 'connected'   -- revoked/error werden übersprungen
      and tn.status = 'active'      -- paused/offboarded ebenso
      and sr.aktiv
    order by ac.tenant_id, sr.report_type
  loop
    -- Fehler EINES Tenants darf die Schleife nicht abbrechen.
    begin
      perform internal.stosse_sync_an(
        r.tenant_id,
        jsonb_build_object('report_type', r.report_type, 'days', r.days)
      );
      angestossen := angestossen + 1;
    exception when others then
      raise warning 'Tenant % / %: Anstoß fehlgeschlagen: %', r.tenant_id, r.report_type, sqlerrm;
    end;
  end loop;

  return angestossen;
end $$;

revoke all on function internal.cron_sync_alle_tenants() from public, anon, authenticated;

-- ---- Wiederaufnahme offener Reports ----
-- sync-report gibt nach 90s bewusst PROCESSING zurück, statt ins Timeout zu laufen.
-- Dieser Lauf holt solche Reports ab. Der report_id-Pfad fordert NICHTS neu an.
create or replace function internal.cron_resume_offene_reports()
returns integer
language plpgsql
security definer
set search_path = internal, public
as $$
declare
  r           record;
  angestossen integer := 0;
begin
  -- Hoffnungslose Fälle zuerst aufgeben, sonst werden sie ewig weiterprobiert.
  update public.report_jobs
     set status = 'FATAL',
         error_detail = 'Nach 6 Stunden immer noch PROCESSING — vom Scheduler aufgegeben.',
         completed_at = now()
   where source = 'sp'
     and status = 'PROCESSING'
     and created_at < now() - interval '6 hours';

  for r in
    select rj.tenant_id, rj.amazon_report_id
    from public.report_jobs rj
    join public.tenants tn on tn.id = rj.tenant_id
    where rj.source = 'sp'
      and rj.status = 'PROCESSING'
      and tn.status = 'active'
      -- Frisch angestoßene in Ruhe lassen: der laufende Aufruf pollt noch selbst.
      and rj.created_at < now() - interval '5 minutes'
  loop
    begin
      perform internal.stosse_sync_an(
        r.tenant_id,
        jsonb_build_object('report_id', r.amazon_report_id)
      );
      angestossen := angestossen + 1;
    exception when others then
      raise warning 'Tenant % / Report %: Wiederaufnahme fehlgeschlagen: %',
        r.tenant_id, r.amazon_report_id, sqlerrm;
    end;
  end loop;

  return angestossen;
end $$;

revoke all on function internal.cron_resume_offene_reports() from public, anon, authenticated;

-- ---- Diagnose ----
-- Gibt NUR zurück, OB die Secrets existieren — niemals ihre Werte.
create or replace function public.scheduler_status()
returns jsonb
language sql
security definer
set search_path = public, cron, vault, internal
as $$
  select jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', jobname, 'schedule', schedule, 'aktiv', active
      ) order by jobname)
      from cron.job
      where jobname in ('sync-alle-tenants-taeglich', 'resume-offene-reports')
    ), '[]'::jsonb),
    'letzte_laeufe', coalesce((
      select jsonb_agg(jsonb_build_object(
        'job', j.jobname, 'status', d.status,
        'meldung', left(coalesce(d.return_message, ''), 200),
        'start', d.start_time
      ) order by d.start_time desc)
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
      where d.start_time > now() - interval '7 days'
    ), '[]'::jsonb),
    'secrets_vorhanden', jsonb_build_object(
      'project_url', exists(select 1 from vault.decrypted_secrets where name = 'project_url'),
      'service_role_key', exists(select 1 from vault.decrypted_secrets where name = 'service_role_key')
    ),
    'report_typen', coalesce((
      select jsonb_agg(jsonb_build_object('typ', report_type, 'days', days, 'aktiv', aktiv) order by report_type)
      from internal.scheduler_reports
    ), '[]'::jsonb),
    'tenants_im_lauf', (
      select count(*)
      from public.auth_contexts ac
      join public.tenants tn on tn.id = ac.tenant_id
      where ac.source = 'sp' and ac.status = 'connected' and tn.status = 'active'
    )
  )
$$;

revoke all on function public.scheduler_status() from public, anon, authenticated;
grant execute on function public.scheduler_status() to service_role;

-- ---- Zeitplan ----
-- unschedule vor schedule, damit die Migration wiederholbar ist (ältere pg_cron
-- werfen bei doppeltem Namen einen Fehler statt zu aktualisieren).
do $$
begin
  begin perform cron.unschedule('sync-alle-tenants-taeglich'); exception when others then null; end;
  begin perform cron.unschedule('resume-offene-reports');      exception when others then null; end;
end $$;

-- 04:30 UTC: nachts, und Sales & Traffic ist wegen stableLagDays ohnehin
-- unabhängig von der Uhrzeit.
select cron.schedule(
  'sync-alle-tenants-taeglich',
  '30 4 * * *',
  $$select internal.cron_sync_alle_tenants()$$
);

-- Alle 15 Minuten nachfassen: ein Amazon-Report braucht oft 1-5 Minuten,
-- das Poll-Budget von sync-report sind 90 Sekunden.
select cron.schedule(
  'resume-offene-reports',
  '*/15 * * * *',
  $$select internal.cron_resume_offene_reports()$$
);

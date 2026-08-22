-- Einkaufspreise täglich aus Sellerboard holen.
--
-- Anlass: Der Import gab es nur als Knopf im Frontend. Zuletzt gedrückt am
-- 31.07.2026 — drei Wochen lang rechneten Rohertrag und Nettogewinn also mit
-- Juli-Preisen, ohne dass das irgendwo auffiel. Ein Datenstand, den ein Mensch
-- von Hand aktuell halten muss, ist kein Datenstand.
--
-- 03:15 UTC: vor sync-finances (03:30) und dem Report-Sync (04:30). Die
-- Einkaufspreise sind eine Eingangsgröße für Rohertrag und Nettogewinn, sie
-- sollten stehen, bevor darauf gerechnet wird.

create or replace function internal.cron_ek_alle_tenants()
returns integer
language plpgsql
security definer
set search_path to 'internal', 'public', 'net'
as $$
declare
  r           record;
  v_url       text := internal.vault_secret('project_url');
  v_key       text := internal.vault_secret('service_role_key');
  angestossen integer := 0;
begin
  if v_url is null or v_key is null then
    raise exception 'Vault-Secrets project_url und/oder service_role_key fehlen — siehe UEBERGABE.md, Abschnitt Scheduler.';
  end if;

  -- Nur Mandanten, die überhaupt einen Link hinterlegt haben. Ohne Link wirft
  -- der Import, und ein täglich geworfener Fehler für einen Mandanten, der
  -- Sellerboard gar nicht nutzt, wäre Rauschen statt Meldung.
  for r in
    select te.tenant_id
    from public.tenant_einstellungen te
    join public.tenants t on t.id = te.tenant_id
    where te.sellerboard_ek_url_secret is not null
      and t.status = 'active'
    order by te.tenant_id
  loop
    begin
      perform net.http_post(
        url     := v_url || '/functions/v1/sync-ek',
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_key
                   ),
        body    := jsonb_build_object('tenant_id', r.tenant_id, 'schreiben', true),
        timeout_milliseconds := 60000
      );
      angestossen := angestossen + 1;
    exception when others then
      raise warning 'EK-Import %: %', r.tenant_id, sqlerrm;
    end;
  end loop;
  return angestossen;
end $$;

revoke all on function internal.cron_ek_alle_tenants() from public, anon, authenticated;

comment on function internal.cron_ek_alle_tenants() is
  'Täglich 03:15 UTC: stösst sync-ek für jeden aktiven Mandanten mit hinterlegtem Sellerboard-Link an.';

select cron.unschedule('sync-ek-taeglich')
where exists (select 1 from cron.job where jobname = 'sync-ek-taeglich');
select cron.schedule('sync-ek-taeglich', '15 3 * * *', $$select internal.cron_ek_alle_tenants()$$);

-- Die Wache muss den EK-Import mitsehen.
--
-- Sonst wiederholt sich genau der Fehler, der diesen Cron nötig gemacht hat: Ein
-- abgelaufener Sellerboard-Link liefert eine HTML-Loginseite statt CSV, der
-- Import schlägt fehl, und die Preise altern still weiter. Der Unterschied zu
-- vorher wäre dann nur, dass das Nichtstun automatisiert ist.
--
-- Basis ist der Stand aus `sync_wache_nur_ungeloest` (Fehlschläge nur melden,
-- wenn kein späterer Lauf sie geheilt hat); ergänzt um zwei EK-Zweige nach
-- derselben Logik: zu lange kein Lauf, und ein vermerkter Fehler.
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
  ),
  -- Mandanten mit hinterlegtem Sellerboard-Link. Ohne Link gibt es nichts zu
  -- holen, und eine Meldung waere Rauschen.
  ek as (
    select t.name, te.sellerboard_ek_zuletzt as zuletzt, te.sellerboard_ek_status as status
    from public.tenant_einstellungen te
    join public.tenants t on t.id = te.tenant_id
    where te.sellerboard_ek_url_secret is not null
      and t.status = 'active'
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

  union all

  -- 3. EK-Import steht still: kein Lauf innerhalb des Fensters.
  select e.name, 'sellerboard-ek', 'kein Erfolg',
         case when e.zuletzt is null
              then 'noch nie gelaufen'
              else 'letzter Lauf vor ' || date_trunc('minute', now() - e.zuletzt)::text
         end
  from ek e
  where e.zuletzt is null or e.zuletzt < now() - p_max_alter

  union all

  -- 4. EK-Import lief, meldete aber einen Fehler (haeufigster Fall: abgelaufener
  --    Export-Link, der eine HTML-Loginseite statt CSV liefert). Aelter als 24 h
  --    faellt schon unter 3. — hier zaehlt der Fehlertext.
  select e.name, 'sellerboard-ek', 'fehlgeschlagen', e.status
  from ek e
  where e.status like 'Fehler%'
    and e.zuletzt > now() - interval '24 hours'
$function$;

comment on function public.sync_stoerungen(interval) is
  'Ausgefallene oder fehlgeschlagene Syncs je Mandant und Quelle, inkl. EK-Import aus Sellerboard (quelle = sellerboard-ek). Zwei Arten: kein Erfolg seit p_max_alter (Standard 36h — ein ausgefallener Tageslauf), und offen gebliebene Fehler der letzten 24h. Jederzeit direkt aufrufbar.';

revoke all on function public.sync_stoerungen(interval) from public;
grant execute on function public.sync_stoerungen(interval) to service_role;

notify pgrst, 'reload schema';

-- Periodischer Sync der externen Bestaende + Sync-Wache dafuer.
--
-- Der Cron laeuft stuendlich und stoesst nur die Mandanten an, deren
-- Intervall abgelaufen ist (Standard 6 h). Das Intervall ist je Mandant
-- einstellbar — ein Prep Center, das dreimal am Tag bucht, braucht einen
-- anderen Takt als ein Lager, das einmal pro Woche zaehlt.
--
-- Gleiches Muster wie internal.cron_ek_alle_tenants: net.http_post mit
-- service_role an die Edge Function; die Logik liegt NUR dort.

create or replace function internal.cron_bestand_extern_faellige()
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

  for r in
    select bv.tenant_id
    from public.bestand_verbindungen bv
    join public.tenants t on t.id = bv.tenant_id
    where bv.url_secret is not null
      and bv.auto_sync
      and bv.quelle = 'sellerboard'
      and t.status = 'active'
      and (bv.zuletzt_versuch is null
           or bv.zuletzt_versuch < now() - (bv.intervall_stunden || ' hours')::interval)
    order by bv.tenant_id
  loop
    begin
      perform net.http_post(
        url     := v_url || '/functions/v1/sync-sellerboard-bestand',
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'Authorization', 'Bearer ' || v_key
                   ),
        body    := jsonb_build_object('tenant_id', r.tenant_id),
        timeout_milliseconds := 60000
      );
      angestossen := angestossen + 1;
    exception when others then
      raise warning 'Bestand-Sync %: %', r.tenant_id, sqlerrm;
    end;
  end loop;
  return angestossen;
end $$;

revoke all on function internal.cron_bestand_extern_faellige() from public, anon, authenticated;

comment on function internal.cron_bestand_extern_faellige() is
  'Stuendlich: stoesst sync-sellerboard-bestand fuer jeden aktiven Mandanten an, dessen Auto-Sync-Intervall abgelaufen ist.';

select cron.unschedule('sync-bestand-extern-stuendlich')
where exists (select 1 from cron.job where jobname = 'sync-bestand-extern-stuendlich');
select cron.schedule('sync-bestand-extern-stuendlich', '20 * * * *', $$select internal.cron_bestand_extern_faellige()$$);

-- Die Wache muss die externen Bestaende mitsehen — und den EK-Import wieder.
--
-- Die Neufassung vom 28.08. (nur geplante Reports melden) hatte die beiden
-- EK-Zweige vom 22.08. stillschweigend verloren: seither meldete die Wache einen
-- abgelaufenen Sellerboard-EK-Link nicht mehr. Hier kommen sie zurueck, dazu
-- zwei Zweige fuer die Bestandsquelle nach derselben Logik: zu lange kein
-- Erfolg, und ein vermerkter Fehler.

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
  ),
  -- Mandanten mit hinterlegtem Sellerboard-EK-Link.
  ek as (
    select t.name, te.sellerboard_ek_zuletzt as zuletzt, te.sellerboard_ek_status as status
    from public.tenant_einstellungen te
    join public.tenants t on t.id = te.tenant_id
    where te.sellerboard_ek_url_secret is not null
      and t.status = 'active'
  ),
  -- Mandanten mit externer Bestandsquelle und eingeschaltetem Auto-Sync. Ohne
  -- Auto-Sync gibt es keine Erwartung, also auch keine Meldung.
  bestand as (
    select t.name, bv.quelle, bv.status, bv.letzter_fehler, bv.zuletzt_versuch, bv.zuletzt_erfolg,
           (bv.intervall_stunden || ' hours')::interval as intervall
    from public.bestand_verbindungen bv
    join public.tenants t on t.id = bv.tenant_id
    where bv.url_secret is not null and bv.auto_sync and t.status = 'active'
  )
  -- 1. Zu lange kein erfolgreicher Lauf.
  select l.name, l.source, 'kein Erfolg',
         case when l.erfolg is null
              then 'noch nie erfolgreich gelaufen'
              else 'letzter Erfolg vor ' || date_trunc('minute', now() - l.erfolg)::text
         end
  from letzter l
  where l.erfolg is null or l.erfolg < now() - p_max_alter

  union all

  -- 2. Fehlschlaege, die offen geblieben sind.
  select o.name, o.source, 'fehlgeschlagen',
         count(*)::text || ' Job(s) ohne Nachlauf: '
           || string_agg(distinct o.report_type, ', ')
           || ' (' || coalesce(max(o.error_detail), 'ohne Meldung') || ')'
  from offen o
  group by o.name, o.source

  union all

  -- 3. EK-Import steht still.
  select e.name, 'sellerboard-ek', 'kein Erfolg',
         case when e.zuletzt is null
              then 'noch nie gelaufen'
              else 'letzter Lauf vor ' || date_trunc('minute', now() - e.zuletzt)::text
         end
  from ek e
  where e.zuletzt is null or e.zuletzt < now() - p_max_alter

  union all

  -- 4. EK-Import lief, meldete aber einen Fehler.
  select e.name, 'sellerboard-ek', 'fehlgeschlagen', e.status
  from ek e
  where e.status like 'Fehler%'
    and e.zuletzt > now() - interval '24 hours'

  union all

  -- 5. Bestandsquelle: zu lange kein Erfolg. Toleranz ist das Groessere aus
  --    p_max_alter und dem Dreifachen des eingestellten Intervalls — ein
  --    Wochen-Intervall darf nicht taeglich als Stoerung erscheinen.
  select b.name, 'sellerboard-' || b.quelle || '-bestand', 'kein Erfolg',
         case when b.zuletzt_erfolg is null
              then 'noch nie erfolgreich gelaufen'
              else 'letzter Erfolg vor ' || date_trunc('minute', now() - b.zuletzt_erfolg)::text
         end
  from bestand b
  where b.zuletzt_erfolg is null
     or b.zuletzt_erfolg < now() - greatest(p_max_alter, b.intervall * 3)

  union all

  -- 6. Bestandsquelle: letzter Lauf meldete einen Fehler (haeufigster Fall:
  --    abgelaufener Export-Link liefert eine Loginseite statt CSV).
  select b.name, 'sellerboard-' || b.quelle || '-bestand', 'fehlgeschlagen', coalesce(b.letzter_fehler, 'ohne Meldung')
  from bestand b
  where b.status = 'fehler'
    and b.zuletzt_versuch > now() - interval '24 hours'
$function$;

comment on function public.sync_stoerungen(interval) is
  'Ausgefallene oder fehlgeschlagene Syncs je Mandant und Quelle: Amazon-Reports (nur geplante), EK-Import (sellerboard-ek) und externe Bestandsquellen (sellerboard-*-bestand). Jederzeit direkt aufrufbar.';

revoke all on function public.sync_stoerungen(interval) from public, anon, authenticated;
grant execute on function public.sync_stoerungen(interval) to service_role;

notify pgrst, 'reload schema';

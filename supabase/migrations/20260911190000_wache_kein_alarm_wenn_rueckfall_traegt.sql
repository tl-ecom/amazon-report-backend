-- GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA faellt bei Amazon an rund der HAELFTE
-- aller Tage aus: 28 DONE gegen 29 FATAL seit dem 31.07., ohne Muster nach
-- Wochentag und immer nach 24 Sekunden, also kein Timeout. Die anderen Reports
-- laufen an denselben Tagen sauber — es liegt an diesem Report, nicht am Konto.
--
-- Seit dem 04.09. gibt es dafuer den Rueckfall auf GET_FBA_INVENTORY_PLANNING_DATA,
-- und er traegt: am 11.09. steht der Bestand um 04:31 mit 35 ASINs und 3.089
-- Stueck. Die Zahlen sind also da. Trotzdem ging jeden zweiten Tag eine
-- Stoerungsmail raus.
--
-- Das ist der Fehler, den diese Migration behebt. Eine Wache, die an jedem
-- zweiten Tag etwas meldet, das folgenlos ist, erzieht den Empfaenger dazu,
-- sie zu ueberlesen — und dann geht die eine Mail unter, die zaehlt.
--
-- NICHT stumm geschaltet wird der Fall, der wirklich weh tut:
--   - Der Rueckfall ist selbst zu alt (> p_max_alter): dann fehlt der Bestand.
--   - Der Report faellt laenger als sieben Tage am Stueck aus: das ist kein
--     Aussetzer mehr, sondern ein Zustand, und `unterwegs` (Zulauf) fehlt die
--     ganze Zeit, weil nur dieser Report ihn kennt.
create or replace function public.sync_stoerungen(p_max_alter interval default '36:00:00'::interval)
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
  -- Traegt der Bestands-Rueckfall gerade? Nur dann darf der MYI-Report
  -- schweigend ausfallen.
  rueckfall as (
    select a.tenant_id, max(a.stand) as stand
    from public.fba_bestandsalter a
    group by a.tenant_id
  ),
  -- Seit wann faellt der MYI-Report ununterbrochen aus?
  myi_letzter_erfolg as (
    select rj.tenant_id, max(rj.completed_at) as erfolg
    from public.report_jobs rj
    where rj.report_type = 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
      and rj.status = 'DONE'
    group by rj.tenant_id
  ),
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
      -- Der eine Report mit belegtem Rueckfall: still, solange der Rueckfall
      -- frisch ist UND der Ausfall nicht laenger als eine Woche dauert.
      and not (
        rj.report_type = 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
        and exists (
          select 1 from rueckfall r
          where r.tenant_id = rj.tenant_id and r.stand > now() - p_max_alter
        )
        and exists (
          select 1 from myi_letzter_erfolg m
          where m.tenant_id = rj.tenant_id and m.erfolg > now() - interval '7 days'
        )
      )
  ),
  ek as (
    select t.name, te.sellerboard_ek_zuletzt as zuletzt, te.sellerboard_ek_status as status
    from public.tenant_einstellungen te
    join public.tenants t on t.id = te.tenant_id
    where te.sellerboard_ek_url_secret is not null
      and t.status = 'active'
  ),
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

  -- 5. Bestandsquelle: zu lange kein Erfolg.
  select b.name, 'sellerboard-' || b.quelle || '-bestand', 'kein Erfolg',
         case when b.zuletzt_erfolg is null
              then 'noch nie erfolgreich gelaufen'
              else 'letzter Erfolg vor ' || date_trunc('minute', now() - b.zuletzt_erfolg)::text
         end
  from bestand b
  where b.zuletzt_erfolg is null
     or b.zuletzt_erfolg < now() - greatest(p_max_alter, b.intervall * 3)

  union all

  -- 6. Bestandsquelle: letzter Lauf meldete einen Fehler.
  select b.name, 'sellerboard-' || b.quelle || '-bestand', 'fehlgeschlagen', coalesce(b.letzter_fehler, 'ohne Meldung')
  from bestand b
  where b.status = 'fehler'
    and b.zuletzt_versuch > now() - interval '24 hours'
$function$;

revoke all on function public.sync_stoerungen(interval) from public, anon, authenticated;
grant execute on function public.sync_stoerungen(interval) to service_role;

notify pgrst, 'reload schema';

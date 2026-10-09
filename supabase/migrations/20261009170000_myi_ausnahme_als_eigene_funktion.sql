-- Dieselbe folgenlose Meldung, zum zweiten Mal.
--
-- GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA faellt bei Amazon regelmaessig aus;
-- seit dem 04.09. faengt der Rueckfall auf GET_FBA_INVENTORY_PLANNING_DATA das
-- ab. Pruefung 2 ("fehlgeschlagen") hat dafuer seit dem 11.09. eine Ausnahme.
--
-- Pruefung 7 ("Bericht verstummt") kam spaeter dazu und meldet denselben
-- Zustand aus einem anderen Blickwinkel — ohne die Ausnahme. Ergebnis am
-- 09.10.: MYI seit dem 07.10. aus, 8 Fehlschlaege in 48 h, Rueckfall frisch von
-- heute 04:31 und aktive Quelle — und trotzdem eine Stoerungsmail.
--
-- Die Bedingung wird deshalb zur benannten Funktion. Dass sie beim Nachbau der
-- Alarmlogik vergessen wurde, ist kein Zufall, sondern passiert mit einer
-- verstreuten Bedingung immer wieder. Als Funktion ist sie auffindbar.
create or replace function public.myi_ausfall_folgenlos(p_tenant uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select
    -- Der Rueckfall liefert einen frischen Bestand ...
    exists (
      select 1 from public.fba_bestandsalter a
       where a.tenant_id = p_tenant and a.stand > now() - interval '36 hours'
    )
    -- ... und der Ausfall ist ein Aussetzer, kein Zustand. Nach sieben Tagen
    -- fehlt dauerhaft der Zulauf (`unterwegs`), den nur MYI kennt.
    and exists (
      select 1 from public.report_jobs rj
       where rj.tenant_id = p_tenant
         and rj.report_type = 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
         and rj.status = 'DONE'
         and rj.completed_at > now() - interval '7 days'
    );
$function$;

comment on function public.myi_ausfall_folgenlos(uuid) is
  'Faellt der MYI-Bestandsreport aus, ohne Folgen? Nur wenn der Planungsreport als Rueckfall frisch ist UND der Ausfall juenger als sieben Tage. Von Pruefung 2 und Pruefung 7 gemeinsam genutzt.';

create or replace function public.sync_stoerungen(p_max_alter interval default '36:00:00'::interval)
returns table(mandant text, quelle text, art text, detail text)
language sql stable security definer set search_path to 'public'
as $function$
  select s.* from (
    select * from public.sync_stoerungen_basis(p_max_alter)

    union all

    -- 7. Ein Bericht, der regelmaessig lief, ist verstummt.
    select x.name, x.source, 'Bericht verstummt',
           string_agg(x.report_type, ', ' order by x.report_type)
             || ' — zuletzt erfolgreich am ' || to_char(min(x.zuletzt), 'DD.MM.')
    from (
      select t.name, ac.source, rj.report_type,
             count(*) filter (where rj.completed_at > now() - interval '14 days'
                                and rj.completed_at <= now() - p_max_alter) as davor,
             max(rj.completed_at) as zuletzt
        from public.auth_contexts ac
        join public.tenants t on t.id = ac.tenant_id
        join public.report_jobs rj
          on rj.tenant_id = ac.tenant_id and rj.source = ac.source and rj.status = 'DONE'
       where ac.status = 'connected' and t.status = 'active'
         -- Dieselbe Ausnahme wie in Pruefung 2: ein abgefangener Ausfall ist
         -- keine Stoerung, egal aus welchem Blickwinkel man ihn ansieht.
         and not (rj.report_type = 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
                  and public.myi_ausfall_folgenlos(ac.tenant_id))
       group by t.name, ac.source, rj.report_type
    ) x
    where x.davor >= 5 and x.zuletzt < now() - p_max_alter
    group by x.name, x.source

    union all

    -- 8. Zwei verbundene Mandanten liefern denselben Report-INHALT.
    select p.name, 'sp', 'Doppeltes Amazon-Konto',
           'Gleicher Report-Inhalt wie bei "' || p.anderer || '" ('
             || p.report_type || '). Beide Mandanten haengen vermutlich am selben '
             || 'Verkaeuferkonto — bitte pruefen. Folge sonst: Daten doppelt, '
             || 'Stummschaltung wirkungslos, Loeschauftrag erfasst nur eine Haelfte.'
    from (
      select distinct t1.name, t2.name as anderer, rd1.report_type
        from public.report_data rd1
        join public.report_data rd2
          on rd2.report_type = rd1.report_type
         and rd2.is_latest and rd1.is_latest
         and rd2.tenant_id <> rd1.tenant_id
         and md5(rd2.payload::text) = md5(rd1.payload::text)
        join public.tenants t1 on t1.id = rd1.tenant_id
        join public.tenants t2 on t2.id = rd2.tenant_id
        join public.auth_contexts a1 on a1.tenant_id = t1.id and a1.status = 'connected'
        join public.auth_contexts a2 on a2.tenant_id = t2.id and a2.status = 'connected'
       where t1.status = 'active' and t2.status = 'active'
         and t1.name < t2.name
         and coalesce((rd1.payload->>'rowCount')::int, 1) > 0
    ) p
  ) s
  where not exists (
    select 1 from public.tenants t where t.name = s.mandant and t.wache_stumm
  )
$function$;

notify pgrst, 'reload schema';

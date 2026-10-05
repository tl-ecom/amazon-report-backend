-- Zwei Mandanten am selben Amazon-Konto faellt sonst niemandem auf.
--
-- Am 05.10. hingen "e-One" und "Test - Eigener Account" an derselben
-- Verkaeuferkonto-Autorisierung: identischer Report-Inhalt ueber fuenf
-- Report-Typen, zwei getrennte Refresh-Tokens, zwei Verbindungszeitpunkte.
-- Folge: e-One war in der Wache stummgeschaltet, seine vier BAD-Meldungen kamen
-- aber ueber den zweiten Mandanten weiter durch. Die Stummschaltung wirkte nicht.
--
-- Fuer eine Mehrmandanten-App ist das der schlimmere Fall: dieselben Sellerdaten
-- doppelt, und ein Loeschauftrag erfasst nur eine Haelfte.
--
-- ERKENNUNG per Payload-Fingerabdruck, nicht per Verkaeufer-ID: die ID liefert
-- erst ein zusaetzlicher API-Aufruf beim Verbinden. Der Fingerabdruck ist da,
-- kostet nichts und hat genau diesen Fall gefunden. Dafuer ist er ein INDIZ,
-- kein Beweis — deshalb steht in der Meldung "pruefen", nicht "ist".
--
-- NUR BERICHTE MIT ZEILEN: ein leerer Report sieht bei jedem Konto gleich aus.
-- Die erste Fassung dieser Pruefung meldete daran Vaneja als Doppelgaenger von
-- e-One — alle drei hatten denselben leeren Retourenbericht (rowCount 0, 689
-- Zeichen). Zwei leere Berichte sind kein Indiz fuer irgendetwas.
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

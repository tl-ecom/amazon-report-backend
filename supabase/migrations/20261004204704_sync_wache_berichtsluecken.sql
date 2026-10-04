-- Die Sync-Wache meldete Fehlschlaege, nicht Abwesenheit. Ihre Pruefung
-- "kein Erfolg" galt je QUELLE: solange irgendein Ads-Bericht durchlief, war
-- die Quelle gruen. So blieben vom 29.09. bis 04.10.2026 sechs Ads-Berichte
-- unbemerkt aus, die eine Migration aus dem Tageslauf geworfen hatte.
--
-- Neue Pruefung je BERICHTSTYP, ohne Liste, die jemand pflegen muesste: ein
-- Bericht, der in den 14 Tagen davor regelmaessig erfolgreich lief (mindestens
-- fuenfmal) und seit p_max_alter gar nicht mehr, ist verstummt.
--
-- Fuenf statt drei: der Abrechnungsbericht erscheint nur alle zwei Wochen und
-- kam in der Gegenprobe auf drei Laeufe — er ist nicht verstummt, er ist selten.
--
-- Gegenprobe an den echten Laeufen: am 30.09. um 14:15 haette die Regel fuer
-- Vaneja und e-One je sechs Berichte gemeldet.
--
-- ponytail: nach 14 Tagen Stille faellt ein Bericht aus dem Fenster und die
-- Meldung verschwindet von selbst. Bis dahin kam sie zwoelfmal per E-Mail.
-- Wer das uebersieht, dem hilft auch eine dreizehnte nicht.
--
-- Die bisherige Funktion bleibt unveraendert unter neuem Namen; die neue ruft
-- sie und haengt die eine Pruefung an. Aufrufer merken nichts.
alter function public.sync_stoerungen(interval) rename to sync_stoerungen_basis;

create or replace function public.sync_stoerungen(p_max_alter interval default '36:00:00'::interval)
returns table(mandant text, quelle text, art text, detail text)
language sql stable security definer set search_path to 'public'
as $function$
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
$function$;

revoke all on function public.sync_stoerungen(interval) from public, anon, authenticated;
grant execute on function public.sync_stoerungen(interval) to service_role;

notify pgrst, 'reload schema';

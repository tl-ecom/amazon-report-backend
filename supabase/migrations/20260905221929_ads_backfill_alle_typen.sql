-- sync_ads_backfill holt jetzt alle drei Ads-Reports nach, nicht nur
-- Advertised Product. Suchbegriffe und Platzierungen waren beim Onboarding
-- bisher nicht dabei — fuer Vaneja habe ich sie am 2026-09-05 von Hand
-- angestossen, fuer den naechsten Kunden soll das nicht noetig sein.
--
-- Je 31-Tage-Stueck drei Anfragen. Advertised Product weiter mit
-- backfill=true (laesst den aktuellen report_data-Satz unberuehrt); die zwei
-- anderen schreiben ohnehin nur in ihre Tagesreihe.
--
-- Vorhaltung: Placement und Advertised Product 95 Tage, Suchbegriffe nur
-- ~65 Tage. Aeltere Suchbegriff-Stuecke nimmt Amazon an und liefert leer —
-- kein Fehler, deshalb wird hier nicht extra unterschieden.

create or replace function public.sync_ads_backfill(p_tenant uuid, p_tage int default 90)
  returns int
  language plpgsql
  security definer
  set search_path to 'public', 'internal', 'net'
as $function$
declare
  v_ende    date;
  v_start   date;
  v_frueh   date;
  v_stuecke int := 0;
begin
  if p_tage is null or p_tage < 1 or p_tage > 95 then
    raise exception 'p_tage muss zwischen 1 und 95 liegen, war: %', p_tage;
  end if;

  if not exists (
    select 1 from public.auth_contexts
    where tenant_id = p_tenant and source = 'ads' and status = 'connected'
  ) then
    raise exception 'Tenant % hat keine verbundene Ads-Quelle.', p_tenant;
  end if;

  -- Juengstes Fenster endet wie im Tagesbetrieb 3 Tage vor heute (VOLATIL_TAGE).
  v_ende  := ((now() at time zone 'utc')::date) - 3;
  v_frueh := v_ende - p_tage;

  while v_ende > v_frueh loop
    v_start := greatest(v_frueh, v_ende - 30);   -- minus 30 = 31 Tage inklusive

    perform internal.stosse_ads_sync_an(p_tenant, jsonb_build_object(
      'start_date', v_start::text, 'end_date', v_ende::text, 'backfill', true));
    perform internal.stosse_ads_sync_an(p_tenant, jsonb_build_object(
      'report_type', 'sp-search-term', 'start_date', v_start::text, 'end_date', v_ende::text));
    perform internal.stosse_ads_sync_an(p_tenant, jsonb_build_object(
      'report_type', 'sp-placement', 'start_date', v_start::text, 'end_date', v_ende::text));

    v_stuecke := v_stuecke + 1;
    v_ende := v_start - 1;   -- naechstes Fenster schliesst lueckenlos an
  end loop;

  return v_stuecke;
end $function$;

comment on function public.sync_ads_backfill(uuid, int) is
  'Holt bis zu 95 Tage Ads-Historie in Stuecken zu hoechstens 31 Tagen nach — je Stueck Advertised Product (backfill=true), Suchbegriffe und Platzierungen. Gibt die Zahl der Stuecke zurueck (Anfragen = Stuecke x 3). Direkt nach connect-ads aufrufen; Suchbegriffe haelt Amazon nur ~65 Tage vor, aeltere Stuecke kommen leer zurueck.';

revoke all on function public.sync_ads_backfill(uuid, int) from public, anon, authenticated;
grant execute on function public.sync_ads_backfill(uuid, int) to service_role;

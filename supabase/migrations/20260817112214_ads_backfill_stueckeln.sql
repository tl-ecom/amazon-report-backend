-- Backfill in 31-Tage-Stuecken statt einer grossen Anfrage.
--
-- Befund vom 2026-08-17: Der erste Backfill-Versuch (90 Tage am Stueck) wurde
-- von Amazon abgelehnt:
--   400 — startDate to endDate range (90 days) must not exceed maximum range (31 days)
--
-- Es gibt also ZWEI Grenzen, die man leicht verwechselt:
--   * Spanne je Anfrage: hoechstens 31 Kalendertage.
--   * Vorhaltung: ~95 Tage. So weit darf man zurueckreichen, danach loescht Amazon.
-- Die frueher hier stehende Annahme "90 Tage gehen in einem Rutsch" war falsch;
-- die 1..90-Pruefung in sync-ads-report hatte ich als API-Grenze fehlgedeutet.
--
-- Diese Fassung laeuft rueckwaerts in lueckenlos anschliessenden Stuecken und
-- gibt deren Anzahl zurueck. Die Chunks laufen mit backfill=true: sie fuellen
-- ads_daily, lassen den aktuellen report_data-Satz (is_latest) aber unberuehrt.
-- Ohne das wuerde nach dem Nachholen das AELTESTE Fenster als aktueller Stand
-- im Ads-Tab erscheinen — je nachdem, welches Stueck zuletzt fertig wird.

-- Rueckgabetyp und Semantik aendern sich (Anzahl Stuecke statt Request-ID).
drop function if exists public.sync_ads_backfill(uuid, int);

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
  -- 95 Tage ist Amazons Vorhaltung — was aelter ist, existiert dort nicht mehr.
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

    perform internal.stosse_ads_sync_an(
      p_tenant,
      jsonb_build_object(
        'start_date', v_start::text,
        'end_date',   v_ende::text,
        'backfill',   true
      )
    );

    v_stuecke := v_stuecke + 1;
    v_ende := v_start - 1;   -- naechstes Fenster schliesst lueckenlos an
  end loop;

  return v_stuecke;
end $function$;

comment on function public.sync_ads_backfill(uuid, int) is
  'Holt bis zu 95 Tage Ads-Historie in Stuecken zu hoechstens 31 Tagen nach (Amazons Grenze je Anfrage) und gibt die Zahl der angestossenen Stuecke zurueck. Die Chunks laufen mit backfill=true: sie fuellen ads_daily, lassen den aktuellen report_data-Satz aber unberuehrt. Direkt nach connect-ads aufrufen — Amazon loescht nach ~95 Tagen. Tagesbetrieb laeuft weiter ueber sync_ads_jetzt.';

revoke all on function public.sync_ads_backfill(uuid, int) from public;
grant execute on function public.sync_ads_backfill(uuid, int) to service_role;

notify pgrst, 'reload schema';

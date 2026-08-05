-- sync_ads_backfill — einmaliger Ads-Sync ueber ein frei waehlbares Fenster.
--
-- Warum zusaetzlich zu sync_ads_jetzt: Jenes fragt fest 30 Tage ab, was fuer den
-- taeglichen Betrieb genau richtig ist. Beim ERSTEN Verbinden eines Kunden ist es
-- aber zu wenig — die Ads-API gibt bis zu 90 Tage her und loescht danach. Was
-- beim Onboarding nicht geholt wird, ist nach ~95 Tagen endgueltig verloren.
--
-- Gedacht als einmaliger Aufruf direkt nach connect-ads:
--   select public.sync_ads_backfill('<tenant-uuid>');
--
-- Gefahrlos wiederholbar: ads_daily wird per Upsert befuellt, ein zweiter Lauf
-- ueberschreibt dieselben Tage mit denselben Zahlen.

create or replace function public.sync_ads_backfill(p_tenant uuid, p_days int default 90)
  returns bigint
  language plpgsql
  security definer
  set search_path to 'public', 'internal', 'net'
as $function$
begin
  -- Die Obergrenze ist die der Ads-API v3, nicht willkuerlich gewaehlt:
  -- hoehere Werte weist sync-ads-report mit HTTP 400 zurueck.
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'p_days muss zwischen 1 und 90 liegen (Grenze der Ads-API), war: %', p_days;
  end if;

  return net.http_post(
    url := internal.vault_secret('project_url') || '/functions/v1/sync-ads-report',
    headers := jsonb_build_object('Content-Type','application/json',
               'Authorization','Bearer '||internal.vault_secret('service_role_key')),
    body := jsonb_build_object('tenant_id', p_tenant, 'days', p_days),
    timeout_milliseconds := 150000
  );
end $function$;

comment on function public.sync_ads_backfill(uuid, int) is
  'Einmaliger Ads-Sync ueber ein frei waehlbares Fenster (max. 90 Tage, Grenze der Ads-API). Direkt nach connect-ads aufrufen, um beim Onboarding die volle verfuegbare Historie in ads_daily zu holen — Amazon loescht Ads-Daten nach ~95 Tagen. Der taegliche Betrieb laeuft weiter ueber sync_ads_jetzt (30 Tage).';

-- Rechte wie bei sync_ads_jetzt: nur Backend, kein Zugriff fuer angemeldete
-- Nutzer. SECURITY DEFINER plus offener EXECUTE-Grant waere eine Hintertuer.
revoke all on function public.sync_ads_backfill(uuid, int) from public;
grant execute on function public.sync_ads_backfill(uuid, int) to service_role;

notify pgrst, 'reload schema';

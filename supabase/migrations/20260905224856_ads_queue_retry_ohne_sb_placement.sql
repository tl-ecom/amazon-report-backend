-- Warteschlange: 429 beim Anfordern wiederholen; sb-placement raus.
--
-- Zwei Befunde vom 2026-09-06:
--   1. Amazon kennt fuer Sponsored Brands keinen Platzierungsbericht —
--      sbCampaigns erlaubt nur groupBy campaign. sb-placement fliegt aus
--      Tageslauf und Backfill.
--   2. Auch einzeln geschickt kam ein Report mit 429 zurueck: Amazons
--      Kontingent fuers Anfordern fuellt sich langsam, und ein Burst am Abend
--      wirkt lange nach. Ein 429 beim Anfordern hinterlaesst keinen Job. Die
--      Warteschlange stellt solche Eintraege deshalb zurueck (sent_at wieder
--      leer) und versucht es beim naechsten Takt erneut — hoechstens fuenfmal,
--      damit ein dauerhaft kaputter Eintrag nicht ewig kreist.

alter table internal.ads_report_queue add column if not exists versuche int not null default 0;
alter table internal.ads_report_queue add column if not exists letzter_fehler text;

create or replace function internal.cron_ads_queue()
returns int language plpgsql security definer set search_path to 'internal','public','net' as $function$
declare r record; n int := 0; v_req bigint;
begin
  -- Zurueckstellen, was beim Anfordern an einem 429 gescheitert ist.
  update internal.ads_report_queue q
     set sent_at = null, request_id = null, versuche = q.versuche + 1,
         letzter_fehler = left(resp.content::text, 300)
    from net._http_response resp
   where resp.id = q.request_id
     and q.sent_at is not null
     and q.versuche < 5
     and resp.status_code = 502
     and resp.content::text like '%429%';

  for r in
    select distinct on (q.tenant_id) q.id, q.tenant_id, q.body
    from internal.ads_report_queue q
    join public.auth_contexts ac on ac.tenant_id = q.tenant_id and ac.source = 'ads' and ac.status = 'connected'
    join public.tenants tn on tn.id = q.tenant_id and tn.status = 'active'
    where q.sent_at is null
    order by q.tenant_id, q.created_at, q.id
  loop
    begin
      v_req := internal.stosse_ads_sync_an(r.tenant_id, r.body);
      update internal.ads_report_queue set sent_at = now(), request_id = v_req where id = r.id;
      n := n + 1;
    exception when others then
      raise warning 'ads-queue % / %: %', r.tenant_id, r.body, sqlerrm;
    end;
  end loop;
  return n;
end $function$;

create or replace function internal.cron_ads_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare r record; n int := 0; t text;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    begin
      perform public.sync_ads_jetzt(r.tenant_id);
      foreach t in array array['sp-search-term','sp-placement','sp-targeting','sb-search-term','sb-targeting','sd-targeting'] loop
        perform internal.ads_report_einstellen(r.tenant_id, jsonb_build_object('report_type', t, 'days', 14));
      end loop;
      n := n + 1;
    exception when others then raise warning 'ads-sync % fehlgeschlagen: %', r.tenant_id, sqlerrm; end;
  end loop;
  return n;
end $function$;

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
  t         text;
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

  v_ende  := ((now() at time zone 'utc')::date) - 3;
  v_frueh := v_ende - p_tage;

  while v_ende > v_frueh loop
    v_start := greatest(v_frueh, v_ende - 30);
    perform internal.ads_report_einstellen(p_tenant, jsonb_build_object(
      'start_date', v_start::text, 'end_date', v_ende::text, 'backfill', true));
    foreach t in array array['sp-search-term','sp-placement','sp-targeting','sb-search-term','sb-targeting','sd-targeting'] loop
      perform internal.ads_report_einstellen(p_tenant, jsonb_build_object(
        'report_type', t, 'start_date', v_start::text, 'end_date', v_ende::text));
    end loop;
    v_stuecke := v_stuecke + 1;
    v_ende := v_start - 1;
  end loop;
  return v_stuecke;
end $function$;

comment on function public.sync_ads_backfill(uuid, int) is
  'Stellt bis zu 95 Tage Ads-Historie in 31-Tage-Stuecken in die Warteschlange — je Stueck sieben Berichte (Advertised Product, SP/SB Suchbegriffe, SP Platzierungen, SP/SB/SD Ziele). cron_ads_queue schickt alle 2 Minuten je Mandant eine Anfrage und wiederholt 429er. Gibt die Zahl der Stuecke zurueck.';

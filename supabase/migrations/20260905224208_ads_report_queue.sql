-- Warteschlange fuer Ads-Reports: eine Anfrage je Mandant alle zwei Minuten.
--
-- Befund vom 2026-09-06: Fuenf Reports auf einmal angefordert, zwei davon von
-- Amazon mit 429 abgewiesen — schon beim ANFORDERN, nicht beim Pollen. Ein so
-- abgewiesener Report hinterlaesst keinen report_jobs-Eintrag, die Wache sieht
-- ihn nicht, und die Tagesreihe hat still eine Luecke.
--
-- pg_net schickt alles, was in einer Transaktion eingestellt wurde, nach dem
-- Commit gleichzeitig los. Ein pg_sleep zwischen den Aufrufen hilft deshalb
-- nicht. Also eine Tabelle als Warteschlange: Tageslauf und Backfill stellen
-- nur noch ein; cron_ads_queue nimmt alle zwei Minuten je Mandant den
-- aeltesten offenen Eintrag und schickt genau den. Acht Typen im Tageslauf
-- sind so nach 16 Minuten unterwegs, ein 90-Tage-Backfill (24 Anfragen) nach
-- 48 Minuten — und kein Report faellt mehr einem Burst zum Opfer.

create table if not exists internal.ads_report_queue (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  body        jsonb not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  request_id  bigint
);
create index if not exists ads_report_queue_offen_idx
  on internal.ads_report_queue (tenant_id, created_at) where sent_at is null;

create or replace function internal.ads_report_einstellen(p_tenant_id uuid, p_body jsonb)
returns bigint language sql security definer set search_path to 'internal' as $function$
  insert into internal.ads_report_queue (tenant_id, body) values (p_tenant_id, p_body) returning id
$function$;

-- Je Mandant genau eine offene Anfrage losschicken. Mandanten ohne aktive
-- Ads-Verbindung bleiben liegen (werden beim Verbinden wieder aufgenommen).
create or replace function internal.cron_ads_queue()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare r record; n int := 0; v_req bigint;
begin
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

-- Tageslauf: Advertised Product sofort (wie bisher), die uebrigen Typen in
-- die Warteschlange.
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
      foreach t in array array['sp-search-term','sp-placement','sp-targeting','sb-search-term','sb-placement','sb-targeting','sd-targeting'] loop
        perform internal.ads_report_einstellen(r.tenant_id, jsonb_build_object('report_type', t, 'days', 14));
      end loop;
      n := n + 1;
    exception when others then raise warning 'ads-sync % fehlgeschlagen: %', r.tenant_id, sqlerrm; end;
  end loop;
  return n;
end $function$;

-- Backfill: alles in die Warteschlange, auch Advertised Product.
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
    foreach t in array array['sp-search-term','sp-placement','sp-targeting','sb-search-term','sb-placement','sb-targeting','sd-targeting'] loop
      perform internal.ads_report_einstellen(p_tenant, jsonb_build_object(
        'report_type', t, 'start_date', v_start::text, 'end_date', v_ende::text));
    end loop;
    v_stuecke := v_stuecke + 1;
    v_ende := v_start - 1;
  end loop;
  return v_stuecke;
end $function$;

comment on function public.sync_ads_backfill(uuid, int) is
  'Stellt bis zu 95 Tage Ads-Historie in 31-Tage-Stuecken in die Warteschlange — je Stueck acht Berichte (Advertised Product, SP/SB Suchbegriffe, SP/SB Platzierungen, SP/SB/SD Ziele). cron_ads_queue schickt alle 2 Minuten je Mandant eine Anfrage. Gibt die Zahl der Stuecke zurueck.';

select cron.schedule('ads-queue', '*/2 * * * *', 'select internal.cron_ads_queue()');

notify pgrst, 'reload schema';

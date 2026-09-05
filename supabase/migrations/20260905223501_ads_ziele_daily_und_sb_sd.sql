-- Ziel-Ebene mit Leistung, Sponsored Brands/Display, Selbstblockade-Regel.
--
-- Nach dem Abgleich mit der Spec fuer Etagere-Mappe und Montags-Waechter
-- fehlten drei Dinge:
--   1. Die Ziel-Ebene: ads_daily ist je beworbener ASIN, nicht je Keyword
--      oder Target. Der spTargeting-Report liefert Leistung je Ziel und Tag
--      samt dem an dem Tag gueltigen Gebot -> ads_ziele_daily.
--   2. Sponsored Brands und Display: Pulse war SP-only. Die Tagesreihen
--      bekommen ad_product ('SP'|'SB'|'SD') in den Schluessel.
--   3. Selbstblockade: Keyword und Negative mit demselben Text in derselben
--      Anzeigengruppe (oder auf Kampagnenebene). Aus dem Struktur-Snapshot per
--      SQL ermittelt, Diagnose-Regel in _shared/diagnostics.ts.
--
-- ATTRIBUTION: SP 7 Tage, SB/SD 14 Tage (Amazons Vorgabe in v3). Die Leser
-- weisen es aus; in der Tabelle steht es nicht, weil es am ad_product haengt.

-- ---------------------------------------------------------------- ad_product

alter table public.ads_suchbegriffe_daily add column if not exists ad_product text not null default 'SP';
alter table public.ads_suchbegriffe_daily drop constraint if exists ads_suchbegriffe_daily_pkey;
alter table public.ads_suchbegriffe_daily
  add primary key (tenant_id, ad_product, datum, campaign_id, ad_group_id, ziel_id, suchbegriff);
alter table public.ads_suchbegriffe_daily add constraint ads_suchbegriffe_daily_ad_product_check
  check (ad_product in ('SP','SB','SD'));

alter table public.ads_placement_daily add column if not exists ad_product text not null default 'SP';
alter table public.ads_placement_daily drop constraint if exists ads_placement_daily_pkey;
alter table public.ads_placement_daily
  add primary key (tenant_id, ad_product, datum, campaign_id, platzierung);
alter table public.ads_placement_daily add constraint ads_placement_daily_ad_product_check
  check (ad_product in ('SP','SB','SD'));

-- ---------------------------------------------------------------- Ziele je Tag

create table if not exists public.ads_ziele_daily (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  ad_product     text not null default 'SP' check (ad_product in ('SP','SB','SD')),
  datum          date not null,
  campaign_id    text not null,
  ad_group_id    text not null default '',
  ziel_id        text not null,
  campaign_name  text,
  ad_group_name  text,
  text           text,
  match_type     text,
  -- Momentaufnahme aus dem Report: das an dem Tag gueltige Gebot / der Zustand.
  gebot_cents    bigint,
  state          text,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  spend_cents    bigint not null default 0,
  sales_cents    bigint not null default 0,
  orders         bigint not null default 0,
  einheiten      bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, ad_product, datum, campaign_id, ad_group_id, ziel_id)
);
comment on table public.ads_ziele_daily is
  'Tagesreihe der Targeting-Berichte (spTargeting/sbTargeting/sdTargeting): Leistung je Keyword bzw. Product-Target und Tag, dazu Gebot und Zustand des Tages. Ersetzt die Bulk-Zeilen Keyword und Produkt-Targeting.';
alter table public.ads_ziele_daily enable row level security;

-- ---------------------------------------------------------------- Summen-RPCs
-- Signaturen aendern sich (ad_product) -> alte Fassungen weg.

drop function if exists public.ads_suchbegriffe_summen(uuid, date, date, text, int);
create or replace function public.ads_suchbegriffe_summen(
  p_tenant uuid, p_von date, p_bis date, p_campaign text default null, p_limit int default 500, p_ad_product text default null
)
returns table (
  ad_product text, campaign_id text, campaign_name text, ad_group_id text, ad_group_name text,
  ziel_id text, ziel_text text, match_type text, suchbegriff text,
  impressions bigint, clicks bigint, spend_cents bigint, sales_cents bigint, orders bigint, einheiten bigint,
  tage int
)
language sql stable security definer set search_path to 'public'
as $function$
  select ad_product, campaign_id,
         nullif(max(coalesce(campaign_name,'')),''),
         ad_group_id,
         nullif(max(coalesce(ad_group_name,'')),''),
         ziel_id,
         nullif(max(coalesce(ziel_text,'')),''),
         nullif(max(coalesce(match_type,'')),''),
         suchbegriff,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint,
         count(distinct datum)::int
  from public.ads_suchbegriffe_daily
  where tenant_id = p_tenant
    and datum between p_von and p_bis
    and (p_campaign is null or campaign_id = p_campaign)
    and (p_ad_product is null or ad_product = p_ad_product)
  group by ad_product, campaign_id, ad_group_id, ziel_id, suchbegriff
  order by sum(spend_cents) desc, sum(clicks) desc
  limit greatest(1, least(p_limit, 5000))
$function$;
revoke all on function public.ads_suchbegriffe_summen(uuid, date, date, text, int, text) from public;
grant execute on function public.ads_suchbegriffe_summen(uuid, date, date, text, int, text) to service_role;

drop function if exists public.ads_placement_summen(uuid, date, date);
create or replace function public.ads_placement_summen(p_tenant uuid, p_von date, p_bis date, p_ad_product text default null)
returns table (
  ebene text, ad_product text, campaign_id text, campaign_name text, platzierung text,
  impressions bigint, clicks bigint, spend_cents bigint, sales_cents bigint, orders bigint, einheiten bigint
)
language sql stable security definer set search_path to 'public'
as $function$
  with basis as (
    select * from public.ads_placement_daily
    where tenant_id = p_tenant and datum between p_von and p_bis
      and (p_ad_product is null or ad_product = p_ad_product)
  )
  select 'gesamt'::text, ad_product, null::text, null::text, platzierung,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by ad_product, platzierung
  union all
  select 'kampagne', ad_product, campaign_id, nullif(max(coalesce(campaign_name,'')),''), platzierung,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by ad_product, campaign_id, platzierung
$function$;
revoke all on function public.ads_placement_summen(uuid, date, date, text) from public;
grant execute on function public.ads_placement_summen(uuid, date, date, text) to service_role;

-- Ziele ueber einen Zeitraum. gebot_cents/state = Stand des JUENGSTEN Tages im
-- Zeitraum (Momentaufnahme, keine Summe). Nach Spend sortiert, gedeckelt.
create or replace function public.ads_ziele_summen(
  p_tenant uuid, p_von date, p_bis date, p_campaign text default null, p_limit int default 500, p_ad_product text default null
)
returns table (
  ad_product text, campaign_id text, campaign_name text, ad_group_id text, ad_group_name text,
  ziel_id text, text text, match_type text, gebot_cents bigint, state text,
  impressions bigint, clicks bigint, spend_cents bigint, sales_cents bigint, orders bigint, einheiten bigint,
  tage int
)
language sql stable security definer set search_path to 'public'
as $function$
  select ad_product, campaign_id,
         nullif(max(coalesce(campaign_name,'')),''),
         ad_group_id,
         nullif(max(coalesce(ad_group_name,'')),''),
         ziel_id,
         nullif(max(coalesce(text,'')),''),
         nullif(max(coalesce(match_type,'')),''),
         (array_agg(gebot_cents order by datum desc))[1],
         (array_agg(state order by datum desc))[1],
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint,
         count(distinct datum)::int
  from public.ads_ziele_daily
  where tenant_id = p_tenant
    and datum between p_von and p_bis
    and (p_campaign is null or campaign_id = p_campaign)
    and (p_ad_product is null or ad_product = p_ad_product)
  group by ad_product, campaign_id, ad_group_id, ziel_id
  order by sum(spend_cents) desc, sum(clicks) desc
  limit greatest(1, least(p_limit, 5000))
$function$;
revoke all on function public.ads_ziele_summen(uuid, date, date, text, int, text) from public;
grant execute on function public.ads_ziele_summen(uuid, date, date, text, int, text) to service_role;

drop function if exists public.ads_tagesreihen_abdeckung(uuid);
create or replace function public.ads_tagesreihen_abdeckung(p_tenant uuid)
returns table (tabelle text, ad_product text, von date, bis date, tage bigint)
language sql stable security definer set search_path to 'public'
as $function$
  select 'suchbegriffe'::text, ad_product, min(datum), max(datum), count(distinct datum)
  from public.ads_suchbegriffe_daily where tenant_id = p_tenant group by ad_product
  union all
  select 'placement'::text, ad_product, min(datum), max(datum), count(distinct datum)
  from public.ads_placement_daily where tenant_id = p_tenant group by ad_product
  union all
  select 'ziele'::text, ad_product, min(datum), max(datum), count(distinct datum)
  from public.ads_ziele_daily where tenant_id = p_tenant group by ad_product
$function$;
revoke all on function public.ads_tagesreihen_abdeckung(uuid) from public;
grant execute on function public.ads_tagesreihen_abdeckung(uuid) to service_role;

-- ---------------------------------------------------------------- Selbstblockade
-- Aktives Keyword, das ein aktives Negative derselben Kampagne trifft:
--   NEGATIVE_EXACT  mit exakt demselben Text in derselben Anzeigengruppe
--                   oder auf Kampagnenebene;
--   NEGATIVE_PHRASE dessen Text als Wortfolge im Keyword vorkommt — eine
--                   Phrase blockiert jede Suchanfrage, die sie enthaelt, also
--                   auch die des eigenen Keywords.
-- Nur aus dem juengsten Snapshot (p_stand).
create or replace function public.ads_selbstblockaden(p_tenant uuid, p_stand timestamptz)
returns table (
  campaign_id text, campaign_name text, ad_group_id text,
  keyword_id text, keyword text, keyword_match text, gebot_cents bigint,
  negative_id text, negative text, negative_match text, negative_ebene text
)
language sql stable security definer set search_path to 'public'
as $function$
  select k.campaign_id, c.name, k.ad_group_id,
         k.ziel_id, k.text, k.match_type, k.gebot_cents,
         n.ziel_id, n.text, n.match_type,
         case when n.art like 'kampagne_%' then 'kampagne' else 'anzeigengruppe' end
  from public.ads_ziele k
  join public.ads_ziele n
    on n.tenant_id = k.tenant_id and n.gesehen_am = k.gesehen_am
   and n.campaign_id = k.campaign_id
   and n.art in ('negativ_keyword', 'kampagne_negativ_keyword')
   and n.state = 'ENABLED'
   and (n.art = 'kampagne_negativ_keyword' or n.ad_group_id = k.ad_group_id)
   and (
        (n.match_type = 'NEGATIVE_EXACT'  and lower(n.text) = lower(k.text))
     or (n.match_type = 'NEGATIVE_PHRASE' and ' ' || lower(k.text) || ' ' like '% ' || lower(n.text) || ' %')
   )
  left join public.ads_kampagnen c on c.tenant_id = k.tenant_id and c.campaign_id = k.campaign_id
  where k.tenant_id = p_tenant and k.gesehen_am = p_stand
    and k.art = 'keyword' and k.state = 'ENABLED'
  order by k.campaign_id, k.text
$function$;
revoke all on function public.ads_selbstblockaden(uuid, timestamptz) from public;
grant execute on function public.ads_selbstblockaden(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------- Cron + Backfill
-- Alle Berichtstypen im Tageslauf und im Backfill. Hat ein Mandant keine SB-
-- oder SD-Kampagnen, liefert Amazon einen leeren Report — kein Fehler.

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
        perform internal.stosse_ads_sync_an(r.tenant_id, jsonb_build_object('report_type', t, 'days', 14));
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
    perform internal.stosse_ads_sync_an(p_tenant, jsonb_build_object(
      'start_date', v_start::text, 'end_date', v_ende::text, 'backfill', true));
    foreach t in array array['sp-search-term','sp-placement','sp-targeting','sb-search-term','sb-placement','sb-targeting','sd-targeting'] loop
      perform internal.stosse_ads_sync_an(p_tenant, jsonb_build_object(
        'report_type', t, 'start_date', v_start::text, 'end_date', v_ende::text));
    end loop;
    v_stuecke := v_stuecke + 1;
    v_ende := v_start - 1;
  end loop;
  return v_stuecke;
end $function$;

comment on function public.sync_ads_backfill(uuid, int) is
  'Holt bis zu 95 Tage Ads-Historie in 31-Tage-Stuecken nach — je Stueck acht Berichte (Advertised Product, SP/SB Suchbegriffe, SP/SB Platzierungen, SP/SB/SD Ziele). Gibt die Zahl der Stuecke zurueck. Direkt nach connect-ads aufrufen.';

notify pgrst, 'reload schema';

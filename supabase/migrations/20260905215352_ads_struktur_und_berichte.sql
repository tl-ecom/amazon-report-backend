-- Ads-Struktur und die zwei fehlenden Berichte — Ersatz fuer die Bulk-Datei.
--
-- Bisher zog Pulse aus der Ads-API nur die Tagesleistung je Kampagne/ASIN.
-- Was sonst in der Bulk-Datei steht — Keywords und Targets mit Geboten,
-- Tagesbudgets, Platzierungs-Modifier, Negatives, Suchbegriffe je Ziel und
-- der Platzierungsbericht — musste von Hand aus der Konsole geladen werden.
-- Alles davon ist ueber dieselbe API abrufbar; ab jetzt holt es der Tageslauf.
--
-- Drei Struktur-Tabellen (Snapshot je Lauf, Stempel gesehen_am) und zwei
-- Tagesreihen (Upsert wie ads_daily). GELD in Cent, Waehrung = Profil-
-- Waehrung, steht nicht im Report und wird deshalb nicht erfunden.

-- ---------------------------------------------------------------- Struktur

create table if not exists public.ads_kampagnen (
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  campaign_id               text not null,
  name                      text,
  state                     text,
  targeting_typ             text,
  budget_cents              bigint,
  budget_typ                text,
  gebots_strategie          text,
  mod_top_prozent           int,
  mod_produktseite_prozent  int,
  mod_rest_prozent          int,
  -- Rohfeld fuer Platzierungen, die die drei Spalten nicht kennen.
  platzierungen_roh         jsonb,
  start_datum               date,
  end_datum                 date,
  gesehen_am                timestamptz not null,
  primary key (tenant_id, campaign_id)
);
comment on table public.ads_kampagnen is
  'Snapshot der SP-Kampagnen aus /sp/campaigns/list: Budget, Gebotsstrategie, Platzierungs-Modifier. gesehen_am = Zeitstempel des Laufs; nur Zeilen mit dem juengsten Stempel sind der aktuelle Stand.';

create table if not exists public.ads_anzeigengruppen (
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  ad_group_id           text not null,
  campaign_id           text not null,
  name                  text,
  state                 text,
  standard_gebot_cents  bigint,
  gesehen_am            timestamptz not null,
  primary key (tenant_id, ad_group_id)
);
create index if not exists ads_anzeigengruppen_kampagne_idx
  on public.ads_anzeigengruppen (tenant_id, campaign_id);

-- Keywords, Product-Targets und Negatives in EINER Tabelle. Die Art gehoert in
-- den Schluessel: Keyword- und Target-IDs kommen bei Amazon aus getrennten
-- Namensraeumen und koennen kollidieren.
create table if not exists public.ads_ziele (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  art           text not null check (art in (
                  'keyword','target',
                  'negativ_keyword','negativ_target',
                  'kampagne_negativ_keyword','kampagne_negativ_target')),
  ziel_id       text not null,
  campaign_id   text not null,
  ad_group_id   text not null default '',
  text          text,
  match_type    text,
  state         text,
  -- NULL = erbt das Standardgebot der Anzeigengruppe (Bulk-Datei: leere Zelle).
  gebot_cents   bigint,
  gesehen_am    timestamptz not null,
  primary key (tenant_id, art, ziel_id)
);
create index if not exists ads_ziele_kampagne_idx
  on public.ads_ziele (tenant_id, campaign_id, gesehen_am);
comment on column public.ads_ziele.gebot_cents is
  'Eigenes Gebot in Cent. NULL heisst geerbt vom Standardgebot der Anzeigengruppe — bewusst nicht aufgefuellt, damit man den Unterschied sieht.';

-- ---------------------------------------------------------------- Tagesreihen

create table if not exists public.ads_suchbegriffe_daily (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  datum          date not null,
  campaign_id    text not null,
  ad_group_id    text not null default '',
  ziel_id        text not null default '',
  suchbegriff    text not null,
  campaign_name  text,
  ad_group_name  text,
  ziel_text      text,
  match_type     text,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  spend_cents    bigint not null default 0,
  sales_cents    bigint not null default 0,
  orders         bigint not null default 0,
  einheiten      bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, datum, campaign_id, ad_group_id, ziel_id, suchbegriff)
);
comment on table public.ads_suchbegriffe_daily is
  'Tagesreihe des Suchbegriff-Berichts (spSearchTerm): welcher Suchbegriff ueber welches Keyword/Target Klicks und Verkaeufe brachte. Grundlage fuer Negatives und Keyword-Ernte.';

create table if not exists public.ads_placement_daily (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  datum          date not null,
  campaign_id    text not null,
  platzierung    text not null,
  campaign_name  text,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  spend_cents    bigint not null default 0,
  sales_cents    bigint not null default 0,
  orders         bigint not null default 0,
  einheiten      bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, datum, campaign_id, platzierung)
);
comment on table public.ads_placement_daily is
  'Tagesreihe des Platzierungsberichts (spCampaigns mit campaignPlacement): Leistung je Kampagne und Platzierung (Top of Search, Produktseite, Rest). Grundlage fuer die Platzierungs-Modifier.';

-- Backend-only wie ads_daily: RLS an, ohne Policy, Zugriff nur via service_role.
alter table public.ads_kampagnen           enable row level security;
alter table public.ads_anzeigengruppen     enable row level security;
alter table public.ads_ziele               enable row level security;
alter table public.ads_suchbegriffe_daily  enable row level security;
alter table public.ads_placement_daily     enable row level security;

-- ---------------------------------------------------------------- Summen-RPCs
-- Wie ads_summen: SQL summiert, TypeScript rechnet Kennzahlen.

create or replace function public.ads_ziele_zaehler(p_tenant uuid, p_stand timestamptz)
returns table (campaign_id text, art text, anzahl bigint)
language sql stable security definer set search_path to 'public'
as $function$
  select campaign_id, art, count(*)::bigint
  from public.ads_ziele
  where tenant_id = p_tenant and gesehen_am = p_stand
  group by campaign_id, art
$function$;
revoke all on function public.ads_ziele_zaehler(uuid, timestamptz) from public;
grant execute on function public.ads_ziele_zaehler(uuid, timestamptz) to service_role;

-- Suchbegriffe ueber einen Zeitraum, je Suchbegriff+Ziel summiert. Optional auf
-- eine Kampagne eingeschraenkt. Nach Spend sortiert und auf p_limit gedeckelt:
-- ein grosses Konto hat Zehntausende Suchbegriffe, die muessen nicht alle
-- durch die Edge Function.
create or replace function public.ads_suchbegriffe_summen(
  p_tenant uuid, p_von date, p_bis date, p_campaign text default null, p_limit int default 500
)
returns table (
  campaign_id text, campaign_name text, ad_group_id text, ad_group_name text,
  ziel_id text, ziel_text text, match_type text, suchbegriff text,
  impressions bigint, clicks bigint, spend_cents bigint, sales_cents bigint, orders bigint, einheiten bigint,
  tage int
)
language sql stable security definer set search_path to 'public'
as $function$
  select campaign_id,
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
  group by campaign_id, ad_group_id, ziel_id, suchbegriff
  order by sum(spend_cents) desc, sum(clicks) desc
  limit greatest(1, least(p_limit, 5000))
$function$;
revoke all on function public.ads_suchbegriffe_summen(uuid, date, date, text, int) from public;
grant execute on function public.ads_suchbegriffe_summen(uuid, date, date, text, int) to service_role;

-- Platzierungen: gesamt je Platzierung und je Kampagne+Platzierung, in einem
-- Ergebnis (ebene unterscheidet), ein Rundtrip.
create or replace function public.ads_placement_summen(p_tenant uuid, p_von date, p_bis date)
returns table (
  ebene text, campaign_id text, campaign_name text, platzierung text,
  impressions bigint, clicks bigint, spend_cents bigint, sales_cents bigint, orders bigint, einheiten bigint
)
language sql stable security definer set search_path to 'public'
as $function$
  with basis as (
    select * from public.ads_placement_daily
    where tenant_id = p_tenant and datum between p_von and p_bis
  )
  select 'gesamt'::text, null::text, null::text, platzierung,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by platzierung
  union all
  select 'kampagne', campaign_id, nullif(max(coalesce(campaign_name,'')),''), platzierung,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by campaign_id, platzierung
$function$;
revoke all on function public.ads_placement_summen(uuid, date, date) from public;
grant execute on function public.ads_placement_summen(uuid, date, date) to service_role;

-- Abdeckung der Tagesreihen: von wann bis wann liegen Daten, damit der Leser
-- sagen kann, ob der gewuenschte Zeitraum ueberhaupt gedeckt ist.
create or replace function public.ads_tagesreihen_abdeckung(p_tenant uuid)
returns table (tabelle text, von date, bis date, tage bigint)
language sql stable security definer set search_path to 'public'
as $function$
  select 'suchbegriffe'::text, min(datum), max(datum), count(distinct datum)
  from public.ads_suchbegriffe_daily where tenant_id = p_tenant
  union all
  select 'placement'::text, min(datum), max(datum), count(distinct datum)
  from public.ads_placement_daily where tenant_id = p_tenant
$function$;
revoke all on function public.ads_tagesreihen_abdeckung(uuid) from public;
grant execute on function public.ads_tagesreihen_abdeckung(uuid) to service_role;

-- ---------------------------------------------------------------- Anstoss + Cron

create or replace function internal.stosse_ads_struktur_an(p_tenant_id uuid)
  returns bigint
  language plpgsql security definer set search_path to 'internal', 'public', 'net'
as $function$
declare
  v_url text := internal.vault_secret('project_url');
  v_key text := internal.vault_secret('service_role_key');
begin
  if v_url is null or v_key is null then
    raise exception 'Vault-Secrets project_url und/oder service_role_key fehlen.';
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/sync-ads-struktur',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object('tenant_id', p_tenant_id),
    timeout_milliseconds := 150000
  );
end $function$;

-- Taeglicher Struktur-Snapshot fuer alle verbundenen Ads-Mandanten.
create or replace function internal.cron_ads_struktur_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare r record; n int := 0;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    begin perform internal.stosse_ads_struktur_an(r.tenant_id); n := n + 1;
    exception when others then raise warning 'ads-struktur % fehlgeschlagen: %', r.tenant_id, sqlerrm; end;
  end loop;
  return n;
end $function$;

-- Der bestehende Tageslauf holt zusaetzlich die zwei neuen Berichte. 14 Tage
-- statt 30: die Suchbegriff-Reihe ist um ein Vielfaches breiter als die
-- ASIN-Reihe, und das taegliche Ueberlappen deckt Amazons 72h-Nachtraege ab.
create or replace function internal.cron_ads_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare r record; n int := 0;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    begin
      perform public.sync_ads_jetzt(r.tenant_id);
      perform internal.stosse_ads_sync_an(r.tenant_id, jsonb_build_object('report_type', 'sp-search-term', 'days', 14));
      perform internal.stosse_ads_sync_an(r.tenant_id, jsonb_build_object('report_type', 'sp-placement', 'days', 14));
      n := n + 1;
    exception when others then raise warning 'ads-sync % fehlgeschlagen: %', r.tenant_id, sqlerrm; end;
  end loop;
  return n;
end $function$;

select cron.schedule('sync-ads-struktur-taeglich', '5 4 * * *', 'select internal.cron_ads_struktur_alle_tenants()');

notify pgrst, 'reload schema';

-- Gebotsautomatik, Stufe 1: rechnen und vorschlagen, NICHT schreiben.
--
-- Zwei Tabellen und drei Lese-RPCs. Der Schreibweg nach Amazon bleibt allein
-- die Function ads-gebote — hier entsteht nur eine Empfehlung, die ein Mensch
-- (oder spaeter Stufe 2) anwendet.
--
-- Warum eigene Regeln statt Helium 10: dort steuert die Automatik nur das
-- Basisgebot und sieht die Platzierungs-Modifier nicht. Bei Vaneja lagen die
-- am 17.09.2026 zwischen 30 und 70 % — die Automatik hat also auf ein Ziel
-- optimiert, das sie strukturell nicht erreichen konnte. Diese Tabellen halten
-- beides zusammen.

-- ---------------------------------------------------------------- Regeln

create table if not exists public.ads_gebotsregeln (
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  campaign_id          text not null,
  -- Ziel-ACoS als Anteil: 0.30 = 30 %. Muss UNTER dem Break-even liegen,
  -- sonst ist die Regel eine Anleitung zum Verlust.
  ziel_acos            numeric(5,4) not null check (ziel_acos > 0 and ziel_acos < 2),
  -- Harte Klammer um jedes Gebot, in Cent.
  min_gebot_cents      bigint not null default 30 check (min_gebot_cents >= 2),
  max_gebot_cents      bigint not null check (max_gebot_cents >= min_gebot_cents),
  -- Groesster erlaubter Sprung je Lauf, in Prozent. Schuetzt vor dem Fall,
  -- dass ein Ausreisser in den Daten ein Gebot halbiert oder verdoppelt.
  max_schritt_prozent  int not null default 15 check (max_schritt_prozent between 1 and 100),
  -- Ab wie vielen Klicks im Fenster ein Ziel eigene Zahlen bekommt. Darunter
  -- wird die CVR der Anzeigengruppe benutzt (siehe gebotsautomatik.ts).
  min_klicks           int not null default 8 check (min_klicks >= 0),
  -- Rueckschau in Tagen, und wie viele der juengsten Tage ausgeschnitten werden.
  -- Amazon bucht Umsaetze bis zu 3 Tage nach; ohne Karenz misst man zu schlecht.
  fenster_tage         int not null default 30 check (fenster_tage between 7 and 120),
  karenz_tage          int not null default 3  check (karenz_tage between 0 and 14),
  aktiv                boolean not null default true,
  notiz                text,
  angelegt_am          timestamptz not null default now(),
  geaendert_am         timestamptz not null default now(),
  primary key (tenant_id, campaign_id)
);
comment on table public.ads_gebotsregeln is
  'Je Kampagne: Ziel-ACoS, Gebotsklammer und Datenschwellen fuer die eigene Gebotsautomatik. Stufe 1 rechnet damit nur Vorschlaege.';
comment on column public.ads_gebotsregeln.karenz_tage is
  'Die juengsten N Tage werden ausgeschnitten. SP attribuiert 7 Tage und Amazon bucht ~3 Tage nach — frische Tage zeigen systematisch zu hohen ACoS.';
alter table public.ads_gebotsregeln enable row level security;

-- ---------------------------------------------------------------- Vorschlaege

create table if not exists public.ads_gebot_vorschlaege (
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  lauf_am              timestamptz not null,
  campaign_id          text not null,
  ad_group_id          text not null default '',
  art                  text not null check (art in ('keyword','target')),
  ziel_id              text not null,
  text                 text,
  match_type           text,
  gebot_alt_cents      bigint,
  gebot_neu_cents      bigint,
  aktion               text not null,
  begruendung          text not null,
  -- Rechenweg mitschreiben: ohne den ist ein Vorschlag nicht pruefbar.
  klicks               bigint not null default 0,
  bestellungen         bigint not null default 0,
  cvr_eigen            numeric(6,4),
  cvr_gruppe           numeric(6,4),
  cvr_genutzt          numeric(6,4),
  umsatz_je_best_cents bigint,
  max_cpc_cents        bigint,
  aufschlag_gewichtet  numeric(6,4),
  belastbar            boolean not null default false,
  primary key (tenant_id, lauf_am, campaign_id, art, ziel_id)
);
create index if not exists ads_gebot_vorschlaege_lauf_idx
  on public.ads_gebot_vorschlaege (tenant_id, lauf_am desc);
comment on table public.ads_gebot_vorschlaege is
  'Ergebnis eines Automatik-Laufs. Stufe 1 schreibt hier hinein und sonst nirgends — nichts davon geht ohne Freigabe nach Amazon.';
alter table public.ads_gebot_vorschlaege enable row level security;

-- ---------------------------------------------------------------- Lese-RPCs
-- SQL summiert, TypeScript rechnet — wie in den uebrigen Modulen.

create or replace function public.ads_automatik_ziele(
  p_tenant uuid, p_von date, p_bis date, p_campaigns text[]
)
returns table (
  campaign_id text, ad_group_id text, ziel_id text, art text,
  text text, match_type text, state text, gebot_cents bigint,
  klicks bigint, bestellungen bigint, spend_cents bigint, sales_cents bigint
)
language sql stable security definer set search_path to 'public'
as $$
  with leistung as (
    select d.campaign_id, d.ad_group_id, d.ziel_id,
           sum(d.clicks) as klicks, sum(d.orders) as bestellungen,
           sum(d.spend_cents) as spend_cents, sum(d.sales_cents) as sales_cents
    from public.ads_ziele_daily d
    where d.tenant_id = p_tenant
      and d.ad_product = 'SP'
      and d.datum between p_von and p_bis
      and d.campaign_id = any(p_campaigns)
    group by 1,2,3
  ),
  -- Nur der juengste Strukturstand; aeltere Snapshots wuerden doppeln.
  stand as (
    select z.* from public.ads_ziele z
    where z.tenant_id = p_tenant
      and z.art in ('keyword','target')
      and z.campaign_id = any(p_campaigns)
      and z.gesehen_am = (
        select max(z2.gesehen_am) from public.ads_ziele z2
        where z2.tenant_id = p_tenant and z2.campaign_id = z.campaign_id
      )
  )
  select s.campaign_id, s.ad_group_id, s.ziel_id, s.art,
         s.text, s.match_type, s.state, s.gebot_cents,
         coalesce(l.klicks, 0), coalesce(l.bestellungen, 0),
         coalesce(l.spend_cents, 0), coalesce(l.sales_cents, 0)
  from stand s
  left join leistung l
    on l.campaign_id = s.campaign_id and l.ziel_id = s.ziel_id;
$$;

create or replace function public.ads_automatik_gruppen(
  p_tenant uuid, p_von date, p_bis date, p_campaigns text[]
)
returns table (
  campaign_id text, ad_group_id text,
  klicks bigint, bestellungen bigint, sales_cents bigint
)
language sql stable security definer set search_path to 'public'
as $$
  select d.campaign_id, d.ad_group_id,
         sum(d.clicks), sum(d.orders), sum(d.sales_cents)
  from public.ads_ziele_daily d
  where d.tenant_id = p_tenant
    and d.ad_product = 'SP'
    and d.datum between p_von and p_bis
    and d.campaign_id = any(p_campaigns)
  group by 1,2;
$$;

-- Klick-Anteil je Platzierung PLUS der aktuell gesetzte Modifier. Genau die
-- Verbindung, die Helium 10 nicht herstellt.
create or replace function public.ads_automatik_platzierungen(
  p_tenant uuid, p_von date, p_bis date, p_campaigns text[]
)
returns table (
  campaign_id text, platzierung text, klicks bigint,
  spend_cents bigint, sales_cents bigint, orders bigint,
  mod_top_prozent int, mod_produktseite_prozent int, mod_rest_prozent int
)
language sql stable security definer set search_path to 'public'
as $$
  with kampagne as (
    select k.* from public.ads_kampagnen k
    where k.tenant_id = p_tenant
      and k.campaign_id = any(p_campaigns)
      and k.gesehen_am = (
        select max(k2.gesehen_am) from public.ads_kampagnen k2
        where k2.tenant_id = p_tenant
      )
  )
  select p.campaign_id, p.platzierung,
         sum(p.clicks), sum(p.spend_cents), sum(p.sales_cents), sum(p.orders),
         max(k.mod_top_prozent), max(k.mod_produktseite_prozent), max(k.mod_rest_prozent)
  from public.ads_placement_daily p
  join kampagne k on k.campaign_id = p.campaign_id
  where p.tenant_id = p_tenant
    and p.datum between p_von and p_bis
    and p.campaign_id = any(p_campaigns)
  group by 1,2;
$$;

revoke all on function public.ads_automatik_ziele(uuid, date, date, text[])          from public, anon;
revoke all on function public.ads_automatik_gruppen(uuid, date, date, text[])        from public, anon;
revoke all on function public.ads_automatik_platzierungen(uuid, date, date, text[])  from public, anon;

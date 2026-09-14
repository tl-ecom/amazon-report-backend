-- Der Marktplatz wird in den Ads-Tabellen zur echten Dimension.
--
-- Bisher hing alles an genau einem Profil (Deutschland), deshalb brauchte es
-- keine Spalte. Sobald ein zweites Profil synchronisiert wird, ist die Spalte
-- Pflicht: Kampagnen-, Anzeigengruppen- und Ziel-IDs sind je Profil vergeben.
-- Ohne Marktplatz im Schluessel wuerde ein franzoesischer Lauf deutsche Zeilen
-- ueberschreiben — dieselbe Falle wie eben beim Query-Performance-Bericht, und
-- genauso still.
--
-- Die WAEHRUNG kommt mit, weil sie nicht ueberall EUR ist: Vanejas Profile
-- umfassen PLN, SEK und GBP. Betraege verschiedener Waehrungen zu summieren
-- waere eine falsche Zahl, die wie eine richtige aussieht.

-- Tagesdaten
alter table public.ads_daily             add column if not exists marktplatz text;
alter table public.ads_placement_daily   add column if not exists marktplatz text;
alter table public.ads_suchbegriffe_daily add column if not exists marktplatz text;
alter table public.ads_ziele_daily       add column if not exists marktplatz text;
-- Struktur
alter table public.ads_kampagnen         add column if not exists marktplatz text;
alter table public.ads_anzeigengruppen   add column if not exists marktplatz text;
alter table public.ads_ziele             add column if not exists marktplatz text;

-- Waehrung nur dort, wo Betraege stehen.
alter table public.ads_daily             add column if not exists waehrung text;
alter table public.ads_placement_daily   add column if not exists waehrung text;
alter table public.ads_suchbegriffe_daily add column if not exists waehrung text;
alter table public.ads_ziele_daily       add column if not exists waehrung text;

-- Bestand nachtragen: alles Bisherige kam ueber das eine verbundene Profil.
do $$
declare t text;
begin
  foreach t in array array[
    'ads_daily','ads_placement_daily','ads_suchbegriffe_daily','ads_ziele_daily',
    'ads_kampagnen','ads_anzeigengruppen','ads_ziele'
  ] loop
    execute format($f$
      update public.%I x
         set marktplatz = ac.marketplace_id
        from public.auth_contexts ac
       where ac.tenant_id = x.tenant_id and ac.source = 'ads' and x.marktplatz is null
    $f$, t);
    execute format('update public.%I set marktplatz = %L where marktplatz is null',
                   t, 'A1PA6795UKMFR9');
    execute format('alter table public.%I alter column marktplatz set not null', t);
  end loop;
end $$;

update public.ads_daily              set waehrung = 'EUR' where waehrung is null;
update public.ads_placement_daily    set waehrung = 'EUR' where waehrung is null;
update public.ads_suchbegriffe_daily set waehrung = 'EUR' where waehrung is null;
update public.ads_ziele_daily        set waehrung = 'EUR' where waehrung is null;

-- Schluessel neu.
alter table public.ads_daily drop constraint if exists ads_daily_pkey;
alter table public.ads_daily add constraint ads_daily_pkey
  primary key (tenant_id, marktplatz, ad_product, datum, campaign_id, ad_group_id, asin, sku);

alter table public.ads_placement_daily drop constraint if exists ads_placement_daily_pkey;
alter table public.ads_placement_daily add constraint ads_placement_daily_pkey
  primary key (tenant_id, marktplatz, ad_product, datum, campaign_id, platzierung);

alter table public.ads_suchbegriffe_daily drop constraint if exists ads_suchbegriffe_daily_pkey;
alter table public.ads_suchbegriffe_daily add constraint ads_suchbegriffe_daily_pkey
  primary key (tenant_id, marktplatz, ad_product, datum, campaign_id, ad_group_id, ziel_id, suchbegriff);

alter table public.ads_ziele_daily drop constraint if exists ads_ziele_daily_pkey;
alter table public.ads_ziele_daily add constraint ads_ziele_daily_pkey
  primary key (tenant_id, marktplatz, ad_product, datum, campaign_id, ad_group_id, ziel_id);

alter table public.ads_kampagnen drop constraint if exists ads_kampagnen_pkey;
alter table public.ads_kampagnen add constraint ads_kampagnen_pkey
  primary key (tenant_id, marktplatz, campaign_id);

alter table public.ads_anzeigengruppen drop constraint if exists ads_anzeigengruppen_pkey;
alter table public.ads_anzeigengruppen add constraint ads_anzeigengruppen_pkey
  primary key (tenant_id, marktplatz, ad_group_id);

alter table public.ads_ziele drop constraint if exists ads_ziele_pkey;
alter table public.ads_ziele add constraint ads_ziele_pkey
  primary key (tenant_id, marktplatz, art, ziel_id);

notify pgrst, 'reload schema';;

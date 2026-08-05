-- ads_daily — Tagesreihe der Sponsored-Products-Kennzahlen.
--
-- Warum ueberhaupt: Amazon haelt Ads-Daten nur ~95 Tage vor, und report_data
-- speichert je Sync lediglich ein rollierendes 30-Tage-Fenster als JSON-Blob.
-- Ohne normalisierte Tagesreihe ist jede laengere Auswertung (ACOS-Verlauf,
-- Vorher/Nachher zu einer Aenderung, Ads im Flight Recorder) nicht abfragbar —
-- und was nicht mitgeschrieben wird, ist nach 95 Tagen endgueltig weg.
--
-- Granularitaet = die des Reports: je Tag, Kampagne, Anzeigengruppe, ASIN und
-- SKU eine Zeile. Das taegliche Sync-Fenster ueberlappt bewusst; der Upsert auf
-- dem Primaerschluessel schreibt die volatilen letzten ~3 Tage jedes Mal neu und
-- korrigiert damit Amazons Nachtraege von selbst.
--
-- GELD in ganzen Cent (bigint), wie im uebrigen Backend — keine Float-Drift.
-- Die Waehrung ist die des Werbeprofils und steht NICHT im Report. Sie wird
-- deshalb bewusst nicht mitgeschrieben, statt sie zu erfinden.

create table if not exists public.ads_daily (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  datum         date not null,
  campaign_id   text not null,
  -- Leerstring statt NULL: in Postgres ist null <> null, ein NULL in einer
  -- Schluesselspalte wuerde die Eindeutigkeit aushebeln und Zeilen vervielfachen.
  ad_group_id   text not null default '',
  asin          text not null default '',
  sku           text not null default '',
  campaign_name text,
  impressions   bigint not null default 0,
  clicks        bigint not null default 0,
  spend_cents   bigint not null default 0,
  sales_cents   bigint not null default 0,
  orders        bigint not null default 0,
  einheiten     bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, datum, campaign_id, ad_group_id, asin, sku)
);

comment on table public.ads_daily is
  'Tagesreihe Sponsored Products je Kampagne/Anzeigengruppe/ASIN. Betraege in Cent, Waehrung = Profil-Waehrung (nicht im Report enthalten). Gefuellt aus sp-advertised-product bei jedem Ads-Sync per Upsert.';

-- ASIN-zentrierte Abfragen (ASIN-Detailseite, Flight Recorder) koennen das
-- Praefix des Primaerschluessels nicht nutzen — dafuer ein eigener Index.
create index if not exists ads_daily_tenant_asin_datum_idx
  on public.ads_daily (tenant_id, asin, datum);

-- Backend-only wie die uebrigen Verlaufstabellen: RLS an, bewusst ohne Policy.
-- Zugriff ausschliesslich ueber service_role, Mandantentrennung im Code.
alter table public.ads_daily enable row level security;

notify pgrst, 'reload schema';

-- Der Report liefert dieselbe SKU je Marktplatz einmal (amazon-store: DE, FR, ...).
-- Ohne den Marktplatz im Schlüssel überschreibt die zuletzt gelesene Zeile die
-- vorherige — dann stehen z. B. französische Gebühren unter einer DE-SKU.
-- Alte Zeilen werden verworfen, weil sie genau diesen Fehler enthalten können.
truncate table public.fba_gebuehrenvorschau;

alter table public.fba_gebuehrenvorschau
  add column if not exists marketplace text not null default 'DE';

alter table public.fba_gebuehrenvorschau
  drop constraint if exists fba_gebuehrenvorschau_pkey;
alter table public.fba_gebuehrenvorschau
  add primary key (tenant_id, sku, marketplace);

comment on column public.fba_gebuehrenvorschau.marketplace is
  'amazon-store aus dem Report. Teil des Schluessels: dieselbe SKU hat je Marktplatz andere Gebuehren.';;

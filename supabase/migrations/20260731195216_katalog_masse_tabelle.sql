-- Katalogmaße: was im Angebot EINGETRAGEN ist.
-- Gegenstück zu fba_gebuehrenvorschau, wo steht, was Amazon GEMESSEN hat.
-- Erst beides zusammen ergibt Modul 3 (Soll-Ist-Abgleich).
--
-- Quelle: Catalog Items API. Getrennt gehalten von den gemessenen Werten, damit
-- nie unklar ist, welche Zahl woher kommt.
create table if not exists public.katalog_masse (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  asin text not null,
  marketplace text not null default 'DE',
  -- Verpackungsmaße, auf cm normalisiert. NULL = im Katalog nicht gepflegt.
  laenge_cm numeric,
  breite_cm numeric,
  hoehe_cm numeric,
  gewicht_g numeric,
  -- Produktmaße ohne Verpackung, falls Amazon sie getrennt führt.
  produkt_laenge_cm numeric,
  produkt_breite_cm numeric,
  produkt_hoehe_cm numeric,
  produkt_gewicht_g numeric,
  marke text,
  stand timestamptz not null default now(),
  raw jsonb,
  primary key (tenant_id, asin, marketplace)
);
alter table public.katalog_masse enable row level security;

comment on table public.katalog_masse is
  'Eingetragene Katalogmasse aus der Catalog Items API. NICHT verwechseln mit fba_gebuehrenvorschau — dort stehen Amazons gemessene Werte, nach denen abgerechnet wird.';;

-- Gebührenvorschau-Report (GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA).
-- Momentaufnahme je SKU: Amazons EIGENE Größenklasse, die gemessenen Maße/das
-- Gewicht und die erwarteten Gebühren. Damit muss Pulse weder Klassengrenzen
-- erfinden noch Gebührenhöhen raten.
create table if not exists public.fba_gebuehrenvorschau (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sku text not null,
  asin text,
  fnsku text,
  produktname text,
  marke text,
  produktgruppe text,
  versand_durch text,                 -- fulfilled-by (AMAZON_EU / AMAZON_NA / DEFAULT)
  hat_lokalen_bestand boolean,
  -- Preise (Cent, NULL = unbekannt)
  preis_cents bigint,                 -- your-price
  verkaufspreis_cents bigint,         -- sales-price
  waehrung text,
  -- Maße, auf cm/g normalisiert (Rohwert + Einheit bleiben in raw)
  laengste_seite_cm numeric,
  mittlere_seite_cm numeric,
  kuerzeste_seite_cm numeric,
  laenge_gurt_cm numeric,
  gewicht_g numeric,
  -- Amazons Klassifizierung — Quelle der Wahrheit für Modul 2
  groessenklasse text,                -- product-size-weight-band
  -- Erwartete Gebühren (Cent, NULL = unbekannt)
  gebuehr_gesamt_cents bigint,        -- estimated-fee-total
  referral_cents bigint,              -- estimated-referral-fee-per-unit
  closing_cents bigint,               -- estimated-variable-closing-fee
  fulfilment_cents bigint,            -- expected-domestic-fulfilment-fee-per-unit
  stand timestamptz not null default now(),
  raw jsonb,
  primary key (tenant_id, sku)
);
alter table public.fba_gebuehrenvorschau enable row level security;
create index if not exists fba_gebuehrenvorschau_asin_idx
  on public.fba_gebuehrenvorschau (tenant_id, asin);

comment on table public.fba_gebuehrenvorschau is
  'Momentaufnahme aus GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA. groessenklasse ist Amazons eigene Angabe (product-size-weight-band) — nicht von Pulse berechnet.';

-- fee_schedule an Amazons Bandnamen koppeln: size_tier == product-size-weight-band.
comment on column public.fee_schedule.size_tier is
  'Muss exakt dem Wert aus fba_gebuehrenvorschau.groessenklasse (Amazons product-size-weight-band) entsprechen, sonst greift der Korridor nicht.';;

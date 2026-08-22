-- Echter FBA-Bestand aus GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA.
-- Momentaufnahme (kein Zeitraum): eine Zeile je SKU, taeglich ueberschrieben.
-- Mengen sind NULL wenn die Spalte leer kam (unbekannt), nie 0 erfunden.
create table if not exists public.fba_bestand (
  tenant_id uuid not null,
  sku text not null,
  asin text,
  fnsku text,
  produktname text,
  preis_cents integer,
  -- Kernmengen
  verkaufsfaehig integer,        -- afn-fulfillable-quantity: sofort verkaufbar
  gesamt integer,               -- afn-total-quantity: alles inkl. unterwegs
  reserviert integer,           -- afn-reserved-quantity
  unverkaeuflich integer,       -- afn-unsellable-quantity
  lager integer,                -- afn-warehouse-quantity
  pruefung integer,             -- afn-researching-quantity
  -- Nachschub unterwegs
  inbound_working integer,      -- angelegt, noch nicht versandt
  inbound_shipped integer,      -- unterwegs zu Amazon
  inbound_receiving integer,    -- im Wareneingang
  mfn_verkaufsfaehig integer,   -- Merchant-Bestand, falls vorhanden
  afn_listing boolean,
  mfn_listing boolean,
  stand timestamptz not null default now(),
  raw jsonb,
  primary key (tenant_id, sku)
);
alter table public.fba_bestand enable row level security;
create index if not exists fba_bestand_asin_idx on public.fba_bestand (tenant_id, asin);;

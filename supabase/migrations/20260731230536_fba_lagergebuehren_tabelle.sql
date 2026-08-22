-- Monatliche Lagergebühren je ASIN (GET_FBA_STORAGE_FEE_CHARGES_DATA).
-- Der Report trennt selbst, was Modul 1 braucht:
--   est_base_msf = Basis-Lagergebühr (Preis des Lagerns)
--   est_sus      = Lagernutzungszuschlag (entsteht durch zu viel Bestand
--                  im Verhältnis zum Abverkauf — eine operative Entscheidung)
--
-- Die Beträge im Report sind NETTO (Rate-Card-Werte). Anders als die gebuchten
-- Gebühren aus der Abrechnung dürfen sie deshalb NICHT durch den USt.-Faktor
-- geteilt werden — sonst rechnet man die Steuer zweimal heraus.
create table if not exists public.fba_lagergebuehren (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  row_hash text not null,
  monat text,                      -- month_of_charge, z. B. '2026-06'
  asin text,
  fnsku text,
  produktname text,
  lager text,                      -- fulfillment_center
  land text,
  groessenklasse text,             -- product_size_tier
  -- Bestand und Volumen
  bestand_schnitt numeric,         -- average_quantity_on_hand
  bestand_entfernung numeric,      -- average_quantity_pending_removal
  bestand_kundenbestellungen numeric,
  volumen numeric,                 -- estimated_total_item_volume
  volumen_einheit text,
  -- Der Auslastungsgrad ist der Auslöser des Zuschlags.
  lagernutzungsgrad numeric,       -- storage_utilization_ratio
  lagernutzungsgrad_einheit text,
  basis_satz numeric,
  zuschlag_satz numeric,
  -- Beträge in Cent, netto
  basis_cents bigint,              -- est_base_msf
  zuschlag_cents bigint,           -- est_sus
  gesamt_cents bigint,             -- estimated_monthly_storage_fee
  waehrung text,
  raw jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, row_hash)
);
alter table public.fba_lagergebuehren enable row level security;
create index if not exists fba_lagergebuehren_monat_idx
  on public.fba_lagergebuehren (tenant_id, monat);
create index if not exists fba_lagergebuehren_asin_idx
  on public.fba_lagergebuehren (tenant_id, asin);

comment on table public.fba_lagergebuehren is
  'Monatliche Lagergebuehren je ASIN. Betraege sind NETTO (Rate-Card-Werte) — nicht nochmal durch den USt.-Faktor teilen.';;

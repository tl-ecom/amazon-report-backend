-- Bestandshistorie: taegliche FBA-Lagerstaende je SKU aus dem
-- Ledger-SUMMARY-Report (GET_LEDGER_SUMMARY_VIEW_DATA, aggregatedByTimePeriod=DAILY).
--
-- Warum eine eigene Tabelle: fba_bestand ist eine MOMENTAUFNAHME (heutiger Stand,
-- wird ueberschrieben). Fuer echte Out-of-Stock-Zeitraeume mit Anfang/Ende/Dauer
-- braucht es den Verlauf — und den liefert nur der Ledger.
--
-- Schluessel: (tenant, Tag, SKU, Disposition, Ort). Amazon fuehrt dieselbe SKU je
-- Tag einmal pro Disposition (SELLABLE/DEFECTIVE/...) und Ort (Land) — ohne diese
-- beiden im Schluessel wuerde die letzte Zeile die richtige ueberschreiben.
create table if not exists public.fba_bestand_verlauf (
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  datum                date not null,
  sku                  text not null,
  disposition          text not null default 'SELLABLE',
  land                 text not null default '',
  asin                 text,
  fnsku                text,
  produktname          text,
  -- Mengen: null = im Report nicht enthalten (UNBEKANNT), nie 0 erfunden.
  start_menge          integer,
  end_menge            integer,
  in_transit           integer,
  zugang               integer,  -- Receipts
  kundenversand        integer,  -- Customer Shipments (negativ)
  kundenretouren       integer,
  lieferantenretouren  integer,
  lager_transfer       integer,
  gefunden             integer,
  verloren             integer,
  beschaedigt          integer,
  entsorgt             integer,
  sonstige             integer,
  unbekannt            integer,
  raw                  jsonb,
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, datum, sku, disposition, land)
);

create index if not exists fba_bestand_verlauf_asin_idx
  on public.fba_bestand_verlauf (tenant_id, asin, datum);

alter table public.fba_bestand_verlauf enable row level security;
-- Bewusst keine Policies: Zugriff ausschliesslich ueber die api-Function (service_role).;

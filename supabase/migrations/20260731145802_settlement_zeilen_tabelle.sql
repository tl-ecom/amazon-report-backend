-- Abrechnungsbericht (Settlement Report V2), Zeile für Zeile.
-- Das ist die AUTORITATIVE Geldquelle: jede Buchung einzeln, mit amount-type und
-- amount-description. Anders als listFinancialEvents zeigt er auch, ob Amazon
-- Steuer auf Gebühren getrennt ausweist — genau die offene Frage.
--
-- Besonderheit: Amazon ERZEUGT diesen Report selbst (alle 14 Tage bzw. je
-- Auszahlung). Er kann nicht angefordert werden, nur aufgelistet und abgeholt.
create table if not exists public.settlement_zeilen (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  row_hash text not null,
  settlement_id text,
  settlement_start date,
  settlement_end date,
  auszahlung_datum date,
  gesamtbetrag_cents bigint,      -- nur in der Kopfzeile gefuellt
  waehrung text,
  transaktionstyp text,           -- transaction-type
  order_id text,
  marktplatz text,
  betrag_typ text,                -- amount-type: ItemPrice | ItemFees | ItemWithheldTax | ...
  betrag_beschreibung text,       -- amount-description: Principal | Commission | FBAPerUnitFulfillmentFee | ...
  betrag_cents bigint,
  gebucht_am date,
  sku text,
  menge int,
  raw jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, row_hash)
);
alter table public.settlement_zeilen enable row level security;

create index if not exists settlement_zeilen_typ_idx
  on public.settlement_zeilen (tenant_id, betrag_typ, betrag_beschreibung);
create index if not exists settlement_zeilen_datum_idx
  on public.settlement_zeilen (tenant_id, gebucht_am);
create index if not exists settlement_zeilen_sku_idx
  on public.settlement_zeilen (tenant_id, sku);

comment on table public.settlement_zeilen is
  'Settlement Report V2, unveraendert normalisiert. Keine Aggregation hier — die Auswertung passiert darueber.';;

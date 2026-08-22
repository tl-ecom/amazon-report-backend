-- Change-Engine: automatisch erkannte Änderungen (Fakt) getrennt vom Nutzerkontext
-- (Interpretation). Dedup über duplicate_key. Vergleichsbasis: asin_snapshots.

create table public.change_events (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  asin                  text,
  seller_sku            text,
  event_type            text not null,          -- preis_geaendert, bestand_null, …
  event_category        text,                   -- angebot | bestand | listing
  source                text not null default 'asin_snapshot_diff',
  detected_automatically boolean not null default true,
  detection_rule        text,
  detected_at           timestamptz not null default now(),
  effective_at          date,                   -- Tag, an dem die Änderung sichtbar wurde
  previous_value        text,
  new_value             text,
  relevance             text,                   -- kritisch|hoch|mittel|niedrig|informativ
  status                text not null default 'neu',  -- neu|kontext_erforderlich|bestaetigt|ignoriert
  requires_context      boolean not null default false,
  duplicate_key         text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, duplicate_key)
);
create index change_events_tenant_asin_idx on public.change_events (tenant_id, asin, detected_at desc);
create index change_events_offen_idx on public.change_events (tenant_id, status) where requires_context;

-- Nutzerkontext strikt getrennt (§21.1): automatisch erkannte Fakten bleiben
-- unberührt, hier stehen nur manuell ergänzte Interpretationen.
create table public.change_event_context (
  id                 uuid primary key default gen_random_uuid(),
  change_event_id    uuid not null references public.change_events(id) on delete cascade,
  classification     text,   -- geplanter_test|operative_anpassung|extern|unbeabsichtigt|nicht_relevant|spaeter
  reason             text,
  hypothesis         text,
  target_metric      text,
  target_value       text,
  responsible_user_id uuid references auth.users(id),
  is_planned_test    boolean,
  external_factor    text,
  note               text,
  confirmed_by       uuid references auth.users(id),
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now(),
  unique (change_event_id)
);

-- Schwellen/Relevanz je Event-Typ (§9.5), später pro Account/ASIN verfeinerbar.
create table public.change_rules (
  event_type       text primary key,
  relevance_default text not null,
  schwellen        jsonb,
  aktiv            boolean not null default true
);
insert into public.change_rules (event_type, relevance_default, schwellen) values
  ('preis_geaendert',            'niedrig', '{"pct_hoch":10,"pct_mittel":3}'::jsonb),
  ('bestand_null',               'kritisch', null),
  ('bestand_wieder_verfuegbar',  'hoch',     null),
  ('listing_deaktiviert',        'kritisch', null),
  ('listing_aktiviert',          'mittel',   null),
  ('fulfillment_geaendert',      'mittel',   null);

alter table public.change_events        enable row level security;
alter table public.change_event_context enable row level security;
alter table public.change_rules         enable row level security;

-- Paart je SKU den heutigen Snapshot mit dem letzten vorherigen (nur wo beide da sind).
create or replace function public.snapshot_paare(p_tenant uuid, p_datum date)
returns table(seller_sku text, asin text, prev jsonb, curr jsonb)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with heute as (
    select * from public.asin_snapshots
    where tenant_id = p_tenant and snapshot_date = p_datum
  ),
  vorher as (
    select distinct on (seller_sku) *
    from public.asin_snapshots
    where tenant_id = p_tenant and snapshot_date < p_datum
    order by seller_sku, snapshot_date desc
  )
  select h.seller_sku, h.asin, to_jsonb(v) as prev, to_jsonb(h) as curr
  from heute h
  join vorher v on v.seller_sku = h.seller_sku;
$function$;;

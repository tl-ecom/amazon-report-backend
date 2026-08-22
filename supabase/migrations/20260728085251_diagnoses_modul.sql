-- Diagnosemodul (§7/§27): regelbasierte, deterministische Diagnosen pro Konto/ASIN.
-- Fakt (beobachtung) getrennt von Begründung; Datenbasis + Konfidenz machen die
-- Herkunft transparent. Ein Lauf gleicht ab: neue Diagnosen anlegen/aktualisieren,
-- weggefallene automatisch auf "behoben". Nutzerentscheidungen (erledigt/verworfen)
-- überleben Läufe.

create table if not exists public.diagnoses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  asin        text,
  typ         text not null,
  beobachtung text not null,
  begruendung text not null,
  datenbasis  jsonb not null default '{}'::jsonb,
  konfidenz   text not null default 'mittel' check (konfidenz in ('hoch','mittel','gering')),
  prioritaet  text not null default 'mittel' check (prioritaet in ('kritisch','hoch','mittel','niedrig')),
  status      text not null default 'offen'  check (status in ('offen','erledigt','verworfen','behoben')),
  fingerprint text not null,             -- typ:asin — stabil, für idempotente Läufe
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, fingerprint)
);

create index if not exists diagnoses_tenant_status_idx on public.diagnoses (tenant_id, status);

-- Kein Direktzugriff: nur die api (service_role, immer tenant-gefiltert).
alter table public.diagnoses enable row level security;;

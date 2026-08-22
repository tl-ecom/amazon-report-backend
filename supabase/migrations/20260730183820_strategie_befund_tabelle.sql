-- Befund je ASIN/Stichtag (Brief Schritt 3). Die KI FORMULIERT; jede Zahl im
-- Text stammt aus der deterministischen Schicht (fakten) und wird vor dem
-- Speichern validiert. modell + prompt_version mitschreiben (Rekonstruierbarkeit).
create table if not exists public.strategie_befund (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  asin text not null,
  stichtag date not null,
  rolle text,
  diagnose text,
  text text,
  fakten jsonb,
  modell text,
  prompt_version text,
  guardrail text,            -- 'ok' | 'ki_verworfen' | 'deterministisch'
  erstellt_am timestamptz not null default now(),
  erstellt_von uuid
);
alter table public.strategie_befund enable row level security;
create index if not exists strategie_befund_asin_idx on public.strategie_befund (tenant_id, asin, erstellt_am desc);;

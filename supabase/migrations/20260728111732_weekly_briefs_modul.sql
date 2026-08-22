-- Weekly Coaching Brief (§16): eingefrorener Wochenschnappschuss je Firma.
-- inhalt (jsonb) hält die zum Erstellzeitpunkt berechnete Zusammenfassung (KPIs
-- mit ihrem echten Report-Zeitraum, offene Diagnosen, Aufgaben-Status, Änderungen
-- der letzten 7 Tage). coach_notiz ergänzt der Coach.

create table if not exists public.weekly_briefs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  zeitraum_von date not null,
  zeitraum_bis date not null,
  inhalt       jsonb not null default '{}'::jsonb,
  coach_notiz  text,
  erstellt_von uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, zeitraum_bis)   -- ein Brief je Stichtag/Firma (Neugenerierung = Update)
);

create index if not exists weekly_briefs_tenant_idx on public.weekly_briefs (tenant_id, zeitraum_bis desc);

alter table public.weekly_briefs enable row level security;;

-- Action Board (§10/§15): Aufgaben. Entweder manuell angelegt oder aus einer
-- Diagnose abgeleitet (quelle='diagnose', diagnose_id verweist zurück). Der Coach
-- kann in der Coach-Ansicht Aufgaben für die gewählte Firma anlegen.

create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  titel        text not null,
  beschreibung text,
  prioritaet   text not null default 'mittel' check (prioritaet in ('kritisch','hoch','mittel','niedrig')),
  status       text not null default 'offen'  check (status in ('offen','in_arbeit','erledigt','verworfen')),
  quelle       text not null default 'manuell' check (quelle in ('manuell','diagnose')),
  diagnose_id  uuid references public.diagnoses(id) on delete set null,
  asin         text,
  faellig_am   date,
  erstellt_von uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  erledigt_am  timestamptz
);

create index if not exists tasks_tenant_status_idx on public.tasks (tenant_id, status);
-- Verhindert doppelte offene Aufgaben aus derselben Diagnose (nur eine aktive je Diagnose).
create unique index if not exists tasks_offen_je_diagnose_idx
  on public.tasks (tenant_id, diagnose_id)
  where diagnose_id is not null and status in ('offen','in_arbeit');

alter table public.tasks enable row level security;;

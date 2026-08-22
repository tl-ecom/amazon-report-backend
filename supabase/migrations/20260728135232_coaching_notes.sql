-- Coaching Notes (§17): Notizen des Coaches pro Coachee-Firma (optional je ASIN).
-- sichtbarkeit = 'intern' (nur Coach/Admin) ODER 'coachee' (Teilnehmer sieht sie
-- als Coach-Kommentar/Feedback). Nur Coach/Admin schreiben; Coachee liest nur
-- die freigegebenen.
create table if not exists public.coaching_notes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  asin         text,
  text         text not null,
  sichtbarkeit text not null default 'intern' check (sichtbarkeit in ('intern','coachee')),
  erstellt_von uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists coaching_notes_tenant_idx on public.coaching_notes (tenant_id, created_at desc);
alter table public.coaching_notes enable row level security;

-- 'notes' als Feature in die Tarif-Matrix aufnehmen: nur Coaching an.
update public.tarif_features set features = jsonb_set(features, '{notes}', 'true'::jsonb)  where tarif = 'coaching';
update public.tarif_features set features = jsonb_set(features, '{notes}', 'false'::jsonb) where tarif in ('premium','vip');;

-- Manuelle Einstellungen je Firma: Ziel-ACOS und ein Kosten-Abschlag (%), mit dem
-- der Seller Amazon-Gebühren/Retouren/Anlieferkosten selbst berücksichtigt, solange
-- die noch nicht automatisch aus der SP-API kommen.
create table if not exists public.tenant_einstellungen (
  tenant_id               uuid primary key references public.tenants(id) on delete cascade,
  ziel_acos_prozent       numeric,
  kosten_abschlag_prozent numeric not null default 0,
  updated_at              timestamptz not null default now()
);
alter table public.tenant_einstellungen enable row level security;;

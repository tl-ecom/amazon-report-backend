-- Spur für alle Ads-Schreibaktionen jenseits von Geboten (Function ads-gebote):
-- Platzierungs-Modifier, Kampagnen-Zustand (SP/SB), Keywords und Negatives anlegen.
-- vorher/nachher als JSON, damit jede Aktion ihr eigenes Format haben darf.
-- RLS an ohne Policies: Zugriff ausschließlich über service_role (Konvention).
create table if not exists public.ads_aenderungen_log (
  id           bigserial primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  aktion       text not null,                 -- platzierung_setzen | sb_kampagne_zustand | sb_negatives_anlegen | keyword_anlegen | negative_anlegen
  objekt_art   text,                          -- campaign | keyword | negative_keyword | sb_campaign | sb_negative_keyword
  objekt_id    text,
  campaign_id  text,
  vorher       jsonb,
  nachher      jsonb,
  ergebnis     text not null,                 -- ok | fehler | uebersprungen
  detail       text,
  grund        text,
  created_at   timestamptz not null default now()
);
alter table public.ads_aenderungen_log enable row level security;
create index if not exists ads_aenderungen_log_tenant_zeit_idx on public.ads_aenderungen_log (tenant_id, created_at desc);
comment on table public.ads_aenderungen_log is
  'Spur aller Ads-Schreibaktionen ausser Geboten (Function ads-gebote). Nur Coach, nur lokal ausgeloest. Keine Geheimnisse.';
notify pgrst, 'reload schema';

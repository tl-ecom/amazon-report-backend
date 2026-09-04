-- Spur für Gebotsänderungen über die Ads-API (Function ads-gebote).
--
-- Der einzige Schreibpfad in Amazon Ads. Jede Zeile, die der Coach setzt, steht
-- hier: wer, wann, welche Firma, welches Keyword/Target, von -> auf, Ergebnis.
-- Auch übersprungene und fehlgeschlagene Zeilen, damit man später weiß, was
-- NICHT passiert ist.
--
-- RLS an ohne Policies: Zugriff ausschließlich über service_role (Konvention).
create table if not exists public.ads_gebote_log (
  id           bigserial primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  art          text not null,                 -- keyword | target
  objekt_id    text not null,                 -- keywordId bzw. targetId
  campaign_id  text,
  ad_group_id  text,
  text         text,                          -- Keyword-Text bzw. Target-Ausdruck
  gebot_alt    numeric(10,2),
  gebot_neu    numeric(10,2) not null,
  ergebnis     text not null,                 -- ok | fehler | uebersprungen
  detail       text,
  grund        text,                          -- freie Begründung des Coachs
  created_at   timestamptz not null default now()
);
alter table public.ads_gebote_log enable row level security;
create index if not exists ads_gebote_log_tenant_zeit_idx on public.ads_gebote_log (tenant_id, created_at desc);

comment on table public.ads_gebote_log is
  'Spur aller Gebotsaenderungen ueber die Ads-API (Function ads-gebote). Nur Coach, nur lokal ausgeloest. Enthaelt keine Geheimnisse.';

notify pgrst, 'reload schema';

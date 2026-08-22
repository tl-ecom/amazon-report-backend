-- Ablaufspur für den OAuth-Handshake.
--
-- Anlass: Ein Verbindungsversuch von Claude scheiterte NACH der Zustimmung. Der
-- Code wurde ausgestellt und nie eingelöst. Jedes Glied einzeln geprüft — alle
-- in Ordnung. Ohne Spur bleibt nur Raten, ob der Client /token gar nicht ruft
-- oder ob wir ihn ablehnen.
--
-- Bewusst OHNE Geheimnisse: keine Codes, keine Tokens, kein code_verifier.
-- Nur Schritt, Ergebnis und ein kurzer Grund.
create table if not exists public.oauth_ereignisse (
  id bigserial primary key,
  schritt text not null,          -- register | authorize | confirm | token
  ergebnis text not null,         -- ok | fehler
  client_id text,
  grund text,                     -- Fehlergrund, gekürzt
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.oauth_ereignisse enable row level security;
create index if not exists oauth_ereignisse_zeit_idx on public.oauth_ereignisse (created_at desc);

comment on table public.oauth_ereignisse is
  'Ablaufspur des OAuth-Handshakes zur Fehlersuche. Enthaelt KEINE Geheimnisse — weder Codes noch Tokens.';

-- Aufraeumen: Diagnosedaten muessen nicht ewig liegen.
create or replace function internal.cron_oauth_ereignisse_aufraeumen()
returns integer language sql security definer set search_path to 'internal','public' as $$
  with weg as (
    delete from public.oauth_ereignisse where created_at < now() - interval '30 days' returning 1
  ) select count(*)::int from weg;
$$;;

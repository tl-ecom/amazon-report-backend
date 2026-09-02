-- Die Schonfrist vom 24.08. bewahrte nur EINEN Vorgaenger auf. Rotiert der
-- Token zweimal kurz hintereinander, faellt der erste heraus, obwohl seine
-- Schonfrist noch laeuft.
--
-- Genau so am 02.09. in der Ablaufspur beobachtet:
--   16:58:50  token ok      -> R1 wird zu R2, R1 in Schonfrist
--   16:59:06  token ok      -> R2 wird zu R3, R2 in Schonfrist, R1 faellt raus
--   16:59:20  token FEHLER  -> jemand kommt mit R1
-- Drei Erneuerungen in 30 Sekunden; die betroffene Client-Instanz hielt die
-- Verbindung danach fuer tot.
--
-- Neu: eine kleine Liste statt eines einzelnen Vorgaengers. Jeder rotierte
-- Token kommt mit seinem eigenen Ablauf hinein, abgelaufene fliegen beim
-- naechsten Schreiben raus, und mehr als fuenf werden nicht aufbewahrt.
--
-- Die alten Spalten bleiben vorerst stehen: Tokens, die noch mit der alten
-- Fassung rotiert wurden, sollen ihre Schonfrist zu Ende leben duerfen.

alter table public.oauth_tokens
  add column if not exists refresh_alt jsonb not null default '[]'::jsonb;

-- Nachschlagen erfolgt ueber Enthaltensein ([{"h": "<hash>"}]), also GIN.
create index if not exists oauth_tokens_refresh_alt_idx
  on public.oauth_tokens using gin (refresh_alt jsonb_path_ops);

comment on column public.oauth_tokens.refresh_alt is
  'Zuletzt rotierte Refresh-Tokens als [{"h": <sha256>, "bis": <iso>}]. Jeder bleibt bis zu seinem "bis" gueltig, damit ein Wettlauf zwischen Client-Instanzen die Verbindung nicht toetet. Hoechstens fuenf Eintraege.';

notify pgrst, 'reload schema';

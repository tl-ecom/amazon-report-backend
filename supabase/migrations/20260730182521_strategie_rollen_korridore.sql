-- Rollen-Default-Korridore je Kennzahl (Brief: "Soll-Korridore je Kennzahl,
-- vorbelegt aus der Rolle"). Map {kennzahl: {min,max}}. Leer, bis TL sie füllt.
-- Der per-ASIN-Override (strategie_korridor) sticht diese Defaults.
alter table public.strategie_definitionen add column if not exists korridore jsonb not null default '{}'::jsonb;;

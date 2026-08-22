-- Wizard-Shell (geführter Pfad) Teilschritt 1a: Rollen-Labels (Brief) +
-- Kennzahl „DB nach Werbung" + per-ASIN-Korridor-Override.
-- Rollen-KEYS bleiben stabil (launch/scale/hold/harvest/exit) -> kein Code-Bruch;
-- die deutschen Brief-Namen kommen als label dazu.

-- 1) Kennzahl-Domain um deckungsbeitrag_nach_werbung erweitern.
do $$
declare cn text;
begin
  select conname into cn from pg_constraint c join pg_type t on t.oid=c.contypid
   where t.typname='strategie_kennzahl' limit 1;
  if cn is not null then execute format('alter domain public.strategie_kennzahl drop constraint %I', cn); end if;
end $$;
alter domain public.strategie_kennzahl add constraint strategie_kennzahl_check
  check (value in ('acos','tacos','umsatz','einheiten','cvr',
                   'deckungsbeitrag_stueck','deckungsbeitrag_nach_werbung',
                   'bestandsreichweite','umsatzanteil_portfolio'));

-- 2) Deutsche Rollen-Labels (Brief) + Beschreibungen.
alter table public.strategie_definitionen add column if not exists label text;
update public.strategie_definitionen set label='Launch',        beschreibung='Sichtbarkeit kaufen, Marge nachrangig.'                 where rolle='launch';
update public.strategie_definitionen set label='Volumentreiber',beschreibung='Umsatz und Rang halten, Marge dünn akzeptiert.'         where rolle='scale';
update public.strategie_definitionen set label='Margenbringer', beschreibung='Deckungsbeitrag vor Umsatz.'                            where rolle='harvest';
update public.strategie_definitionen set label='Verteidigung',  beschreibung='Position gegen Wettbewerber halten.'                    where rolle='hold';
update public.strategie_definitionen set label='Auslauf',       beschreibung='Bestand abverkaufen, Werbung minimieren.'              where rolle='exit';

-- 3) Per-ASIN-Korridor-Override (Brief: korridor(asin_rolle_id, kennzahl, min, max, ueberschrieben)).
--    Effektiver Korridor = Override (falls vorhanden) sonst Rollen-Default aus
--    strategie_definitionen. ueberschrieben markiert bewusst gesetzte Werte.
create table if not exists public.strategie_korridor (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  asin text not null,
  kennzahl public.strategie_kennzahl not null,
  min numeric,
  max numeric,
  ueberschrieben boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (tenant_id, asin, kennzahl)
);
alter table public.strategie_korridor enable row level security;
create index if not exists strategie_korridor_tenant_asin_idx on public.strategie_korridor (tenant_id, asin);;

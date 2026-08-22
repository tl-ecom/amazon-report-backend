-- Strategie-Layer pro ASIN (Rollen/Korridore). Schritt 1: Schema + RLS.
-- Ehrlichkeit: KEINE Benchmark-Zahlen im Code. Korridorwerte kommen aus
-- config/strategy-definitions.ts (vom Coach gefüllt) und werden dorthin gespiegelt.
-- Konvention wie im Rest: tenant-Tabellen mit RLS AN + ohne Policies -> Zugriff
-- ausschliesslich durch die api-Edge-Function als service_role mit explizitem
-- tenant_id-Filter. strategie_definitionen ist global (wie change_rules).

-- Erlaubte Kennzahlen (leading_kpi / muted_metrics). Rank bewusst NICHT dabei
-- (keine Datenquelle angebunden).
create domain public.strategie_kennzahl as text
  check (value in (
    'acos','tacos','umsatz','einheiten','cvr',
    'deckungsbeitrag_stueck','bestandsreichweite','umsatzanteil_portfolio'
  ));

-- 1) Definitionen (global). leading_kpi/korridor bewusst NULLbar: die 5 Rollen-
--    KEYS sind bekannt, die WERTE fuellt der Coach. "nicht konfiguriert" ist ein
--    ehrlicher Zustand (Engine meldet dann nichts, sondern "Strategie unvollstaendig").
create table if not exists public.strategie_definitionen (
  rolle           text primary key,
  leading_kpi     public.strategie_kennzahl,                 -- null = noch nicht gesetzt
  korridor        jsonb   not null default '{"min":null,"max":null}'::jsonb,
  alert_regeln    jsonb   not null default '[]'::jsonb,
  muted_metrics   text[]  not null default '{}',
  max_dauer_tage  int     check (max_dauer_tage is null or max_dauer_tage > 0),
  beschreibung    text,
  aktiv           boolean not null default true,
  updated_at      timestamptz not null default now()
);

-- Die 5 Rollen-Keys anlegen (Namen kommen aus dem Auftrag), OHNE erfundene Zahlen.
insert into public.strategie_definitionen (rolle, beschreibung) values
  ('launch',  'Neueinführung — Sichtbarkeit/Rank aufbauen; Anlaufverluste bewusst.'),
  ('scale',   'Wachstum — profitabel skalieren, Volumen ausbauen.'),
  ('hold',    'Halten — stabile Position/Cashcow verteidigen.'),
  ('harvest', 'Ernten — Marge maximieren, Ausgaben zurückfahren.'),
  ('exit',    'Auslauf — Restbestand abverkaufen, Ressourcen abziehen.')
on conflict (rolle) do nothing;

-- 2) Zuordnung ASIN -> Strategie mit lueckenloser Historie.
create table if not exists public.asin_strategien (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  asin          text not null,
  rolle         text not null references public.strategie_definitionen(rolle),
  quelle        text not null check (quelle in ('suggested','confirmed')),
  gueltig_ab    timestamptz not null default now(),
  gueltig_bis   timestamptz,                                  -- null = aktiv
  bestaetigt_am timestamptz,
  bestaetigt_von uuid references auth.users(id),
  review_faellig date,
  konfidenz     text check (konfidenz in ('high','medium','low')),
  begruendung   text,
  basis         jsonb,                                        -- Felder, auf denen die Zuordnung beruht
  notiz         text,
  created_at    timestamptz not null default now()
);
-- Genau EINE aktive Strategie je ASIN (Wechsel = alte Zeile gueltig_bis setzen + neue einfuegen).
create unique index if not exists asin_strategien_aktiv_uidx
  on public.asin_strategien (tenant_id, asin) where gueltig_bis is null;
create index if not exists asin_strategien_asin_idx
  on public.asin_strategien (tenant_id, asin, gueltig_ab desc);

-- 3) Vorschlaege (warten auf Bestaetigung; ein Vorschlag ist NIE selbst aktiv).
create table if not exists public.strategie_vorschlaege (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  asin               text not null,
  vorgeschlagene_rolle text not null references public.strategie_definitionen(rolle),
  konfidenz          text not null check (konfidenz in ('high','medium','low')),
  begruendung        text not null,                           -- ein Satz
  basis              jsonb not null default '{}'::jsonb,
  status             text not null default 'offen'
                       check (status in ('offen','angenommen','abgelehnt','ersetzt')),
  erstellt_am        timestamptz not null default now(),
  entschieden_am     timestamptz,
  entschieden_von    uuid references auth.users(id)
);
-- Max. EIN offener Vorschlag je ASIN (Neu-Lauf ersetzt/aktualisiert den offenen).
create unique index if not exists strategie_vorschlaege_offen_uidx
  on public.strategie_vorschlaege (tenant_id, asin) where status = 'offen';

-- 4) Korridor-Beobachtungen: pro Lauf & ASIN ein strukturierter, exportierbarer Datensatz.
create table if not exists public.korridor_beobachtungen (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  asin               text not null,
  rolle              text not null,
  beobachtet_am      date not null,
  leading_kpi        text,
  leading_wert       numeric,
  kennzahlen         jsonb not null default '{}'::jsonb,      -- alle Kennzahlwerte des Laufs
  preisklasse        text,
  wochen_seit_launch int,
  ergebnis           text not null
                       check (ergebnis in ('im_korridor','ausserhalb','nicht_bewertbar')),
  created_at         timestamptz not null default now()
);
-- Ein Datensatz je ASIN & Tag (idempotenter Lauf).
create unique index if not exists korridor_beobachtungen_uidx
  on public.korridor_beobachtungen (tenant_id, asin, beobachtet_am);
create index if not exists korridor_beobachtungen_export_idx
  on public.korridor_beobachtungen (tenant_id, rolle, beobachtet_am);

-- RLS: ueberall AN. Tenant-Tabellen ohne Policies -> nur service_role (api) mit
-- explizitem tenant-Filter. Definitionen global, ebenfalls nur service_role.
alter table public.strategie_definitionen  enable row level security;
alter table public.asin_strategien          enable row level security;
alter table public.strategie_vorschlaege    enable row level security;
alter table public.korridor_beobachtungen   enable row level security;;

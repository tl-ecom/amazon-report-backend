-- Fee Decoder — Stammdaten (Schritt 2).
-- Grundsatz aus dem Brief: KEINE Gebührenwerte und KEINE Klassengrenzen im Code
-- und keine erfundenen Zahlen. Hier steht nur das Schema; die Werte pflegt TL
-- per CSV-Import bzw. direkt.

-- 1) Hebel — GESCHLOSSENE Liste mit genau fünf Einträgen (Brief).
--    Dient der Einordnung ins Coaching-Modell, NICHT dem Routing.
create table if not exists public.fee_hebel (
  hebel text primary key,
  label text not null,
  sortierung int not null
);
alter table public.fee_hebel enable row level security;

insert into public.fee_hebel (hebel, label, sortierung) values
  ('produkt_market_fit', 'Produkt-Market-Fit', 1),
  ('content',            'Content', 2),
  ('ppc',                'PPC', 3),
  ('social_trust',       'Social Trust / Bewertungen', 4),
  ('operations',         'Operations / Supply Chain / Zahlen beherrschen', 5)
on conflict (hebel) do update set label = excluded.label, sortierung = excluded.sortierung;

-- 2) Gebührentabelle, VERSIONIERT. Ermöglicht später den Befundtyp
--    "Bei der Gebührenanpassung zum TT.MM.JJJJ kippen diese ASINs unter die Zielmarge".
create table if not exists public.fee_schedule (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null default 'DE',
  size_tier text not null,
  max_longest_side_cm numeric,
  max_median_side_cm numeric,
  max_shortest_side_cm numeric,
  max_weight_g numeric,
  fee_eur numeric,
  gueltig_ab date not null,
  gueltig_bis date,
  quelle text,                      -- z. B. "Amazon-Gebührenübersicht 2026"
  updated_at timestamptz not null default now(),
  unique (marketplace, size_tier, gueltig_ab)
);
alter table public.fee_schedule enable row level security;
create index if not exists fee_schedule_gueltig_idx
  on public.fee_schedule (marketplace, gueltig_ab desc);

comment on table public.fee_schedule is
  'Amazon-Groessenklassen + FBA-Gebuehr je Marktplatz, versioniert. Werte werden von TL gepflegt (CSV-Import), NIEMALS im Code erfunden oder gescrapt.';

-- 3) Klassifizierung der Gebührentypen: steuerbar vs. nicht steuerbar + Hebel.
--    Mapping-Tabelle statt switch — Amazon fuehrt laufend neue Typen ein.
--    Unbekannte Typen laufen in 'unclassified' und erzeugen einen Admin-Hinweis,
--    statt still zu verschwinden.
create table if not exists public.fee_type_classification (
  fee_typ text primary key,          -- exakt wie von Amazon geliefert
  label text,                        -- deutsche Anzeige
  steuerbar boolean,                 -- NULL = noch nicht klassifiziert
  hebel text references public.fee_hebel(hebel),
  hebel_alternativ text references public.fee_hebel(hebel), -- fuer Hypothesen-Faelle
  massnahme text,                    -- Massnahmentext haengt am TYP, nicht am Hebel
  hinweis text,
  quelle text,                       -- 'brief' = aus der Spezifikation uebernommen
  updated_at timestamptz not null default now()
);
alter table public.fee_type_classification enable row level security;

comment on column public.fee_type_classification.hebel_alternativ is
  'Zweiter moeglicher Hebel, wenn er aus den Gebuehrendaten allein nicht bestimmbar ist (z. B. Returns Processing Fee: Erwartungsluecke vs. Produktqualitaet). Dann werden BEIDE als Hypothese ausgegeben.';;

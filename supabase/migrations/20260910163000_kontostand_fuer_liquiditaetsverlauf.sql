-- Kontostand des Geschaeftskontos: der einzige Wert, den Pulse fuer den
-- Liquiditaetsverlauf braucht und nicht messen kann. Er kommt vom Verkaeufer.
--
-- Bewusst der BANK-Stand, nicht "Bank plus Amazon": was noch bei Amazon liegt,
-- kommt ueber die Auszahlungen im Kalender herein. Beides zu addieren hiesse,
-- dasselbe Geld zweimal zu zaehlen.
alter table public.tenant_einstellungen
  add column if not exists kontostand_cents bigint,
  add column if not exists kontostand_am date,
  -- Untergrenze, die der Verkaeufer halten will. null = keine Vorgabe; dann
  -- wird nur das Minus gemeldet, nicht ein erfundener Mindestpuffer.
  add column if not exists kontostand_puffer_cents bigint;

comment on column public.tenant_einstellungen.kontostand_cents is
  'Stand des Geschaeftskontos in Cent, vom Verkaeufer gemeldet. Ohne Amazon-Guthaben.';
comment on column public.tenant_einstellungen.kontostand_am is
  'Stichtag des gemeldeten Kontostands. Aelter als 30 Tage: kein Verlauf mehr.';
comment on column public.tenant_einstellungen.kontostand_puffer_cents is
  'Mindestpuffer in Cent. null = keine Vorgabe.';

notify pgrst, 'reload schema';

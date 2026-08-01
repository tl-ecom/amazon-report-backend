-- Zielmarge als Firmenvorgabe
--
-- Die Gebühren-Vorschau braucht eine Untergrenze, gegen die sie rechnet. Die
-- gehört eigentlich in den Strategie-Pfad: je ASIN ein Korridor, sonst der
-- Korridor der Rolle. Beides ist heute leer — die Rollen-Korridore pflegt der
-- Coach, und bis dahin hätte die Vorschau für jedes Produkt „keine Zielmarge
-- hinterlegt" gemeldet.
--
-- Diese Spalte ist die dritte Stufe der Kaskade, nicht ihr Ersatz:
--   ASIN-Korridor -> Rollen-Korridor -> Firmenvorgabe -> nichts.
-- Welche Stufe gegriffen hat, steht an jedem Befund. Eine im Code hinterlegte
-- Standardmarge gibt es weiterhin nicht: Ist auch diese Spalte leer, bleibt das
-- Ergebnis „keine Zielmarge hinterlegt".

alter table public.tenant_einstellungen
  add column if not exists ziel_marge_prozent numeric;

alter table public.tenant_einstellungen
  drop constraint if exists tenant_einstellungen_ziel_marge_check;
alter table public.tenant_einstellungen
  add constraint tenant_einstellungen_ziel_marge_check
  check (ziel_marge_prozent is null or (ziel_marge_prozent >= 0 and ziel_marge_prozent < 100));

comment on column public.tenant_einstellungen.ziel_marge_prozent is
  'Untergrenze Deckungsbeitrag nach Werbung in Prozent vom Nettoumsatz. Dritte Stufe der Kaskade hinter ASIN- und Rollen-Korridor. NULL = keine Vorgabe.';

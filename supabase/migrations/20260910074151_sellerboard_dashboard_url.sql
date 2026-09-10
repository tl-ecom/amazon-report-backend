-- Sellerboard-Dashboard als Gegenprobe.
--
-- Pulse rechnet Umsatz, Gebuehren, Werbung und Steuer aus Amazons Rohdaten.
-- Sellerboard rechnet dieselben Groessen aus denselben Quellen, aber mit
-- eigener Logik. Weichen beide stark ab, stimmt bei einem von beiden etwas
-- nicht — und das faellt sonst erst auf, wenn jemand zufaellig hinsieht.
--
-- An Vanejas August 2026 gepruft: Umsatz 63.663 € (Pulse) gegen 64.092 €
-- (Sellerboard), Einheiten 2.523 gegen 2.518. Das passt. Die Auszahlungsquote
-- dagegen hatte Pulse mit 33 % statt 46 % gerechnet — genau die Art Fehler,
-- die eine monatliche Gegenprobe fangen soll.
--
-- Der Link enthaelt ein Zugangsgeheimnis und liegt deshalb im Vault, nicht in
-- dieser Spalte. Gespeichert wird nur die Secret-ID — dasselbe Muster wie beim
-- bestehenden sellerboard_ek_url_secret.
alter table public.tenant_einstellungen
  add column if not exists sellerboard_dashboard_url_secret uuid,
  add column if not exists sellerboard_dashboard_zuletzt timestamptz,
  add column if not exists sellerboard_dashboard_status text;

comment on column public.tenant_einstellungen.sellerboard_dashboard_url_secret is
  'Vault-Secret mit dem Sellerboard-Automation-Link (Dashboard nach Monat, CSV). Nie im Klartext hier.';

-- Ergebnis der Gegenprobe je Monat. Bewusst eine eigene Tabelle: die Abweichung
-- ist ein Befund mit Verlauf, kein Zustand. Wer wissen will, seit wann etwas
-- auseinanderlaeuft, braucht die Historie.
create table if not exists public.sellerboard_abgleich (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  monat         text not null,
  kennzahl      text not null,
  pulse_cents   bigint,
  sellerboard_cents bigint,
  -- Abweichung in Prozent, bezogen auf Sellerboard. NULL = nicht berechenbar.
  abweichung_prozent numeric,
  bewertung     text not null,
  geprueft_am   timestamptz not null default now(),
  primary key (tenant_id, monat, kennzahl)
);

alter table public.sellerboard_abgleich enable row level security;
-- Bewusst ohne Policies: Zugriff ausschliesslich ueber service_role.

create index if not exists sellerboard_abgleich_zeit_idx
  on public.sellerboard_abgleich (tenant_id, monat desc);

comment on table public.sellerboard_abgleich is
  'Monatliche Gegenprobe der Pulse-Zahlen gegen Sellerboard. bewertung: ok | abweichung | stark | nicht_pruefbar.';

notify pgrst, 'reload schema';;

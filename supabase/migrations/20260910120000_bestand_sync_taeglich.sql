-- Sellerboard erneuert einen Automation-Export hoechstens TAEGLICH (Auswahl dort:
-- taeglich, jeden Montag, monatlich). Ein 6-Stunden-Takt holte also dreimal am
-- Tag denselben Stand. Voreinstellung deshalb 24 h; erlaubt sind jetzt bis zu
-- 744 h (31 Tage), damit "monatlich" (720 h) einstellbar ist.
alter table public.bestand_verbindungen
  alter column intervall_stunden set default 24;
alter table public.bestand_verbindungen
  drop constraint if exists bestand_verbindungen_intervall_stunden_check;
alter table public.bestand_verbindungen
  add constraint bestand_verbindungen_intervall_stunden_check
  check (intervall_stunden between 1 and 744);

-- Bestehende Verbindungen mit der alten Voreinstellung auf taeglich.
update public.bestand_verbindungen set intervall_stunden = 24, updated_at = now()
where intervall_stunden = 6;

comment on column public.bestand_verbindungen.intervall_stunden is
  'Mindestabstand zwischen zwei Sync-Laeufen in Stunden. Sellerboard erneuert den Export hoechstens taeglich — 24 (taeglich), 168 (woechentlich) oder 720 (monatlich) sind die sinnvollen Werte.';

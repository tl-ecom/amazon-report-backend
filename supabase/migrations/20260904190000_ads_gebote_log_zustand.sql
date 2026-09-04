-- Gebots-Log auch für Zustandsänderungen (Keyword/Target pausieren oder aktivieren).
-- Eine Zeile kann Gebot, Zustand oder beides ändern; gebot_neu darf deshalb leer sein.
alter table public.ads_gebote_log alter column gebot_neu drop not null;
alter table public.ads_gebote_log add column if not exists state_alt text;
alter table public.ads_gebote_log add column if not exists state_neu text;
comment on column public.ads_gebote_log.state_neu is 'ENABLED | PAUSED, wenn der Zustand geändert wurde; sonst null';
notify pgrst, 'reload schema';

-- Freitext-Notiz für manuelle Änderungen (Auto-Events lassen sie null).
alter table public.change_events add column if not exists note text;

comment on column public.change_events.note is
  'Freitext-Notiz, v.a. für manuell erfasste Änderungen (source=manuell).';;

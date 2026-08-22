-- Wer hat den Zugang erstellt? Coach-Token (vom Admin in Coach-Ansicht erzeugt)
-- sind für den Teilnehmer unsichtbar und nicht widerrufbar; er sieht nur eigene.
alter table public.mcp_tokens add column if not exists created_by uuid references auth.users(id);
comment on column public.mcp_tokens.created_by is
  'Ersteller des Tokens. Teilnehmer sehen/widerrufen nur eigene (created_by = self); Coach/Admin sieht alle.';;

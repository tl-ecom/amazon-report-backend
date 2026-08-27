-- Die Ablaufspur deckt bisher nur den OAuth-Handshake ab. Am 24.08. lief der
-- vollstaendig durch (token: ok), der Client meldete danach trotzdem "Server hat
-- nicht geantwortet". Dass die Anfrage ankam, liess sich nur indirekt zeigen —
-- ueber oauth_tokens.last_used_at. Ob und wie schnell wir geantwortet haben,
-- war von aussen nicht sichtbar.
--
-- Deshalb protokolliert jetzt auch die mcp-Funktion in dieselbe Tabelle
-- (schritt = 'mcp:initialize', 'mcp:tools/list', ...). Weiterhin OHNE Inhalte:
-- keine Tokens, keine Argumente, keine Ergebnisse — nur Methode, Ausgang und
-- Dauer.

alter table public.oauth_ereignisse
  add column if not exists dauer_ms integer;

comment on table public.oauth_ereignisse is
  'Ablaufspur von OAuth-Handshake und MCP-Aufrufen zur Fehlersuche. Enthaelt KEINE Geheimnisse und keine Nutzdaten — nur Schritt, Ausgang, Grund und Dauer.';

comment on column public.oauth_ereignisse.dauer_ms is
  'Serverseitige Bearbeitungsdauer in Millisekunden. Trennt "wir waren zu langsam" von "der Client hat die Antwort nicht angenommen".';;

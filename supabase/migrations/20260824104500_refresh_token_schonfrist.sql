-- Refresh-Token-Rotation ohne Schonfrist trennt die Verbindung.
--
-- Bisher: Bei jeder Erneuerung wird refresh_hash ueberschrieben. Der alte Token
-- ist sofort und endgueltig tot. Das ist sicherheitstechnisch sauber, aber in
-- der Praxis fatal — ein claude.ai-Konnektor gilt KONTOWEIT: Web, Desktop und
-- App teilen sich denselben Refresh-Token. Erneuern zwei davon fast gleichzeitig,
-- gewinnt einer; der andere bekommt "Refresh-Token unbekannt" und haelt die
-- Verbindung fuer tot. Dasselbe passiert bei einem Wiederholungsversuch, wenn
-- die Antwort unterwegs verloren geht.
--
-- Nachgewiesen am 24.08.: 07:56:13 token ok, 07:57:03 token FEHLER
-- ("Refresh-Token unbekannt oder widerrufen") — 50 Sekunden spaeter. Der Token
-- vom 22.08. war damit tot, nach 48 Stunden. Insgesamt neun Neuverbindungen
-- seit dem 30.07. allein fuer Vaneja.
--
-- Neu: Der vorherige Refresh-Token bleibt eine kurze Zeit gueltig. Damit
-- ueberlebt ein Wettlauf oder ein Wiederholungsversuch, ohne dass ein
-- abgelaufener Token dauerhaft brauchbar bliebe.

alter table public.oauth_tokens
  add column if not exists refresh_vorher_hash text,
  add column if not exists refresh_vorher_bis  timestamptz;

-- Nachschlagen erfolgt ueber diesen Hash, also indizieren. Partiell: gesetzte
-- Werte sind die Ausnahme und verschwinden nach Ablauf der Schonfrist wieder.
create index if not exists oauth_tokens_refresh_vorher_idx
  on public.oauth_tokens (refresh_vorher_hash)
  where refresh_vorher_hash is not null;

comment on column public.oauth_tokens.refresh_vorher_hash is
  'Hash des zuletzt rotierten Refresh-Tokens. Bleibt bis refresh_vorher_bis gueltig, damit ein Wettlauf zwischen zwei Client-Instanzen die Verbindung nicht toetet.';
comment on column public.oauth_tokens.refresh_vorher_bis is
  'Ende der Schonfrist fuer refresh_vorher_hash. Danach zaehlt nur noch refresh_hash.';

notify pgrst, 'reload schema';

-- Sync-Wache meldet per E-Mail statt Slack.
--
-- Warum E-Mail: Eine Ausfallmeldung darf nicht davon abhaengen, dass jemand eine
-- bestimmte App offen hat. Slack war meine Annahme, nicht eine Entscheidung —
-- das Skript dort ist seit einem Monat unberuehrt.
--
-- Warum Resend und nicht Gmail: Postgres kann nur HTTP. Die Gmail-API braucht
-- OAuth mit stuendlichem Token-Tausch; das in plpgsql zu bauen waere ein
-- Fehlgriff. Resend ist ein API-Schluessel und ein POST.
--
-- Warum als Absender NICHT tl-ecom.de: Dafuer muesste die Domain bei Resend
-- verifiziert werden (SPF/DKIM bei IONOS, dort ohnehin eine bekannte Luecke).
-- Fuer eine interne Betriebsmeldung ist der Absender egal — Hauptsache sie kommt
-- an. Resends Standardabsender darf an die eigene Kontoadresse zustellen, und
-- genau die ist das Ziel.

create or replace function internal.cron_sync_wache()
returns integer
language plpgsql
security definer
set search_path to 'internal', 'public', 'net'
as $function$
declare
  r        record;
  zeilen   text := '';
  anzahl   integer := 0;
  schluessel text;
  empfaenger constant text := 'info@tl-ecom.de';
begin
  for r in select * from public.sync_stoerungen() loop
    zeilen := zeilen || format('- %s / %s: %s (%s)', r.mandant, r.quelle, r.art, r.detail) || chr(10);
    anzahl := anzahl + 1;
  end loop;

  if anzahl = 0 then
    return 0;
  end if;

  begin
    schluessel := internal.vault_secret('resend_api_key');
  exception when others then
    schluessel := null;
  end;

  -- Ohne hinterlegten Schluessel trotzdem melden, nur eben ins Postgres-Log.
  -- Sonst waere die Wache selbst der naechste stille Ausfall.
  if schluessel is null or schluessel = '' then
    raise warning 'Sync-Wache: % Stoerung(en), aber kein resend_api_key im Vault. %', anzahl, zeilen;
    return anzahl;
  end if;

  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || schluessel),
    body    := jsonb_build_object(
                 'from',    'Operator Pulse <onboarding@resend.dev>',
                 'to',      jsonb_build_array(empfaenger),
                 'subject', format('Operator Pulse: %s Sync-Stoerung(en)', anzahl),
                 'text',    format(
                   'Die taegliche Pruefung hat %s Stoerung(en) gefunden:%s%s%s%s',
                   anzahl, chr(10), chr(10), zeilen,
                   chr(10) || 'Selbst nachsehen: select * from public.sync_stoerungen();' || chr(10)
                   || 'Kein Erfolg = seit ueber 36 h kein DONE-Job. Fehlgeschlagen = FATAL in den letzten 24 h.')),
    timeout_milliseconds := 15000
  );
  return anzahl;
end $function$;

comment on function internal.cron_sync_wache() is
  'Taeglicher Waechter (06:00 UTC): schickt sync_stoerungen() per Resend an info@tl-ecom.de. Ohne resend_api_key im Vault wird ins Postgres-Log gewarnt statt still zu schweigen.';;

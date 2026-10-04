-- Ads-Hinweise in der taeglichen E-Mail: "Begriff eingebrochen".
--
-- Anlass: Vanejas "kratzbrett l form" wurde am 25.09.2026 aus Broad geerntet,
-- als Exact angelegt und in der Quelle negiert. Davor 4 Bestellungen in sieben
-- Tagen, danach keine mehr — aufgefallen ist es erst neun Tage spaeter und nur,
-- weil jemand den Bereich geoeffnet hat. Ernten und zugleich negieren ist
-- richtig; es braucht aber jemanden, der nachsieht, ob das neue Keyword anlaeuft.
--
-- WANN GEMELDET WIRD: 7 bis 9 Tage nach der Anlage, also hoechstens dreimal.
-- Davor ist es zu frueh, danach hat man es gelesen oder will es nicht lesen.
--
-- DIE SCHWELLEN stehen ein zweites Mal in _shared/ads_wirkung.ts (MIN_TAGE 7,
-- MIN_KLICKS 5, Einbruch = unter ein Viertel). ponytail: zwei Stellen fuer drei
-- Zahlen. Zusammenlegen, sobald eine dritte Stelle sie braucht.
create or replace function public.ads_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  with laender as (
    select ac.tenant_id, t.name,
           coalesce(m.mp, public.ads_haupt_marktplatz(ac.tenant_id)) as marktplatz
      from public.auth_contexts ac
      join public.tenants t on t.id = ac.tenant_id
      left join lateral (select mp from internal.ads_aktive_marktplaetze(ac.tenant_id) mp) m on true
     where ac.source = 'ads' and ac.status = 'connected' and t.status = 'active'
  ),
  ziele as (
    select l.name, l.marktplatz, r
      from laender l,
           jsonb_array_elements(
             public.ads_keyword_wirkung(l.tenant_id, l.marktplatz, current_date - 40, current_date) -> 'zeilen'
           ) r
     where l.marktplatz is not null
  )
  select z.name, 'Begriff eingebrochen',
         format('%s (%s, angelegt am %s in %s): davor %s Klicks und %s Bestellungen, seither %s Klicks und %s Bestellungen ueber alle Ziele. Gebot zu niedrig oder in der Quelle negiert?',
                z.r ->> 'text',
                coalesce(z.r ->> 'match_type', z.r ->> 'art'),
                to_char((z.r ->> 'angelegt')::timestamptz, 'DD.MM.'),
                coalesce(z.r ->> 'campaign_name', 'unbekannter Kampagne'),
                z.r #>> '{vorher,clicks}', z.r #>> '{vorher,orders}',
                (z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int,
                (z.r #>> '{eigen,orders}')::int + (z.r #>> '{anderswo,orders}')::int)
    from ziele z
   where (z.r ->> 'tage')::int between 7 and 9
     and z.r -> 'vorher' is not null and z.r -> 'vorher' <> 'null'::jsonb
     and (z.r #>> '{vorher,clicks}')::int >= 5
     and ((z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int) * 4
         < (z.r #>> '{vorher,clicks}')::int
$function$;

revoke all on function public.ads_hinweise() from public, anon, authenticated;
grant execute on function public.ads_hinweise() to service_role;

-- Die Wache verschickt beides in EINER Mail, getrennt ueberschrieben: eine
-- Sync-Stoerung ist ein Defekt, ein Ads-Hinweis ist eine Beobachtung.
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
  hinweise text := '';
  n_hinw   integer := 0;
  schluessel text;
  empfaenger constant text := 'info@tl-ecom.de';
begin
  for r in select * from public.sync_stoerungen() loop
    zeilen := zeilen || format('- %s / %s: %s (%s)', r.mandant, r.quelle, r.art, r.detail) || chr(10);
    anzahl := anzahl + 1;
  end loop;

  -- Die Hinweise sind Beiwerk: scheitern sie, gehen die Stoerungen trotzdem raus.
  begin
    for r in select * from public.ads_hinweise() loop
      hinweise := hinweise || format('- %s: %s — %s', r.mandant, r.art, r.detail) || chr(10);
      n_hinw := n_hinw + 1;
    end loop;
  exception when others then
    hinweise := format('- Ads-Hinweise konnten nicht gelesen werden: %s', sqlerrm) || chr(10);
    n_hinw := 1;
  end;

  if anzahl = 0 and n_hinw = 0 then
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
    raise warning 'Sync-Wache: % Stoerung(en), % Ads-Hinweis(e), aber kein resend_api_key im Vault. % %', anzahl, n_hinw, zeilen, hinweise;
    return anzahl + n_hinw;
  end if;

  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || schluessel),
    body    := jsonb_build_object(
                 'from',    'Operator Pulse <onboarding@resend.dev>',
                 'to',      jsonb_build_array(empfaenger),
                 'subject', format('Operator Pulse: %s Sync-Stoerung(en), %s Ads-Hinweis(e)', anzahl, n_hinw),
                 'text',
                   case when anzahl > 0 then
                     format('Die taegliche Pruefung hat %s Stoerung(en) gefunden:%s%s%s', anzahl, chr(10), chr(10), zeilen)
                     || chr(10) || 'Selbst nachsehen: select * from public.sync_stoerungen();' || chr(10)
                     || 'Kein Erfolg = seit ueber 36 h kein DONE-Job. Fehlgeschlagen = FATAL in den letzten 24 h. '
                     || 'Bericht verstummt = lief regelmaessig, seit ueber 36 h nicht mehr.' || chr(10) || chr(10)
                   else '' end
                   ||
                   case when n_hinw > 0 then
                     format('Ads-Hinweise (%s):%s%s%s', n_hinw, chr(10), chr(10), hinweise)
                     || chr(10) || 'Ein Hinweis ist eine Beobachtung, kein Defekt. Details im Bereich Ads-Kandidaten, '
                     || 'Abschnitt Wirkung neuer Keywords. Gemeldet wird 7 bis 9 Tage nach der Anlage.' || chr(10)
                   else '' end),
    timeout_milliseconds := 15000
  );
  return anzahl + n_hinw;
end $function$;

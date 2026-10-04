-- Account Health in der taeglichen Mail.
--
-- Der Bereich Account Health zeigt Handlungsbedarf — aber nur dem, der ihn
-- oeffnet. Gebaut wurde er wegen der einen Luecke, bei der ein Verkaeufer
-- Schaden nimmt, ohne dass Pulse es merkt: Amazon stuft eine Kennzahl herab
-- oder setzt das Konto auf "gefaehrdet". Das muss ankommen, nicht warten.
--
-- GEMELDET WIRD, was Amazon selbst als nicht in Ordnung fuehrt:
--   - eine Kennzahl mit einem Status ausser GOOD / NONE / GREAT / NORMAL
--   - ein Account-Health-Rating ausser GOOD / GREAT
--   - ein Kontostatus ausser NORMAL
-- NICHT gemeldet wird "Ziel verfehlt trotz gutem Status": das ist eine
-- Beobachtung fuer den Bereich, kein Anlass fuer eine Mail.
--
-- TAEGLICH, solange der Zustand anhaelt — anders als bei den Ads-Hinweisen.
-- Ein gefaehrdetes Konto ist nicht nach drei Mails erledigt.
--
-- Dieselben unauffaelligen Status stehen in _shared/account_health.ts
-- (UNAUFFAELLIG). Geprueft an einer Probe-Nutzlast: vier Meldungen; an Vanejas
-- echtem Bericht vom 04.10.2026: keine.
create or replace function public.account_health_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public'
as $function$
  with berichte as (
    select t.name, rd.payload
      from public.report_data rd
      join public.tenants t on t.id = rd.tenant_id
     where rd.report_type = 'GET_V2_SELLER_PERFORMANCE_REPORT' and rd.is_latest
       and t.status = 'active' and not t.wache_stumm
  ),
  pm as (
    select b.name, m
      from berichte b,
           jsonb_array_elements(coalesce(b.payload -> 'performanceMetrics', '[]'::jsonb)) m
  ),
  flach as (
    select pm.name, pm.m ->> 'marketplaceId' as mp, e.key as kennzahl, e.value as v
      from pm, jsonb_each(pm.m) e
     where jsonb_typeof(e.value) = 'object' and e.value ? 'status'
    union all
    -- orderDefectRate kommt je Versandart (afn / mfn).
    select pm.name, pm.m ->> 'marketplaceId', e.key || '.' || u.key, u.value
      from pm, jsonb_each(pm.m) e, jsonb_each(e.value) u
     where jsonb_typeof(e.value) = 'object' and not (e.value ? 'status')
       and jsonb_typeof(u.value) = 'object' and u.value ? 'status'
  )
  select f.name, 'Account Health',
         format('%s: Amazon meldet %s (Wert %s, Ziel %s) auf %s',
                f.kennzahl, f.v ->> 'status',
                coalesce(f.v ->> 'rate', f.v ->> 'defectsCount', '—'),
                coalesce(f.v ->> 'targetValue', '—'), f.mp)
    from flach f
   where f.v ->> 'status' not in ('GOOD', 'NONE', 'GREAT', 'NORMAL')

  union all

  select pm.name, 'Account Health',
         format('Account-Health-Rating: %s (%s Punkte) auf %s',
                pm.m #>> '{accountHealthRating,ahrStatus}',
                coalesce(pm.m #>> '{accountHealthRating,ahrScore}', '—'), pm.m ->> 'marketplaceId')
    from pm
   where pm.m #>> '{accountHealthRating,ahrStatus}' not in ('GOOD', 'GREAT')

  union all

  select b.name, 'Account Health',
         format('Kontostatus: %s auf %s', s ->> 'status', s ->> 'marketplaceId')
    from berichte b, jsonb_array_elements(coalesce(b.payload -> 'accountStatuses', '[]'::jsonb)) s
   where s ->> 'status' <> 'NORMAL'
$function$;

revoke all on function public.account_health_hinweise() from public, anon, authenticated;
grant execute on function public.account_health_hinweise() to service_role;

-- Die Wache liest jetzt beide Hinweis-Quellen. Sonst unveraendert.
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
  -- Account Health zuerst — ein gefaehrdetes Konto wiegt schwerer als ein Keyword.
  begin
    for r in
      select * from public.account_health_hinweise()
      union all
      select * from public.ads_hinweise()
    loop
      hinweise := hinweise || format('- %s: %s — %s', r.mandant, r.art, r.detail) || chr(10);
      n_hinw := n_hinw + 1;
    end loop;
  exception when others then
    hinweise := hinweise || format('- Hinweise konnten nicht vollstaendig gelesen werden: %s', sqlerrm) || chr(10);
    n_hinw := n_hinw + 1;
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
    raise warning 'Sync-Wache: % Stoerung(en), % Hinweis(e), aber kein resend_api_key im Vault. % %', anzahl, n_hinw, zeilen, hinweise;
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
                 'subject', format('Operator Pulse: %s Sync-Stoerung(en), %s Hinweis(e)', anzahl, n_hinw),
                 'text',
                   case when anzahl > 0 then
                     format('Die taegliche Pruefung hat %s Stoerung(en) gefunden:%s%s%s', anzahl, chr(10), chr(10), zeilen)
                     || chr(10) || 'Selbst nachsehen: select * from public.sync_stoerungen();' || chr(10)
                     || 'Kein Erfolg = seit ueber 36 h kein DONE-Job. Fehlgeschlagen = FATAL in den letzten 24 h. '
                     || 'Bericht verstummt = lief regelmaessig, seit ueber 36 h nicht mehr.' || chr(10) || chr(10)
                   else '' end
                   ||
                   case when n_hinw > 0 then
                     format('Hinweise (%s):%s%s%s', n_hinw, chr(10), chr(10), hinweise)
                     || chr(10) || 'Account Health: was Amazon selbst als nicht in Ordnung fuehrt — taeglich, solange es anhaelt. '
                     || 'Begriff eingebrochen: 7 bis 9 Tage nach der Anlage eines Keywords; Details im Bereich '
                     || 'Ads-Kandidaten, Abschnitt Wirkung neuer Keywords.' || chr(10)
                   else '' end),
    timeout_milliseconds := 15000
  );
  return anzahl + n_hinw;
end $function$;

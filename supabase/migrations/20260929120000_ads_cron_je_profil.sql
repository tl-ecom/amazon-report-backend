-- Die Ads-Tageslaeufe laufen ab jetzt je AKTIVEM PROFIL, nicht je Mandant.
--
-- Stand vorher: Schema, Ingest-Functions und SQL-Leser sind seit dem 14.09. voll
-- marktplatzfaehig — `marktplatz` ist Teil jedes Primaerschluessels, und sowohl
-- sync-ads-report als auch sync-ads-struktur nehmen `marktplatz` im Body und
-- loesen das passende Profil ueber ads_profile auf. Gefehlt hat nur der Anstoss:
-- die Crons liefen ueber auth_contexts und riefen die Functions OHNE marktplatz.
-- Damit zog jeder Mandant genau das eine verbundene Profil — bei allen
-- Deutschland. Frankreich war deshalb nicht leer, sondern gar nicht vorhanden.
--
-- SICHERHEITSNETZ: Hat ein Mandant kein einziges ads_profile mit aktiv=true,
-- laeuft er weiter wie bisher — ein Durchgang ohne marktplatz. Diese Migration
-- veraendert also fuer niemanden etwas, solange niemand ein Profil freischaltet.
-- Das Freischalten bleibt die bewusste Entscheidung, die ads_profile vorsieht:
-- ein zusaetzliches Profil kostet API-Kontingent und bewegt Zahlen.

-- ---------------------------------------------------------------- Welche Laender?

-- Liefert die Marktplaetze, fuer die dieser Mandant Ads ziehen soll.
-- Leeres Ergebnis heisst ausdruecklich "wie bisher, ohne Marktplatz-Angabe" —
-- der Aufrufer muss diesen Fall behandeln, nicht raten.
create or replace function internal.ads_aktive_marktplaetze(p_tenant uuid)
returns setof text
language sql stable security definer set search_path to 'internal', 'public'
as $function$
  select distinct p.marktplatz
    from public.ads_profile p
   where p.tenant_id = p_tenant
     and p.aktiv
     and p.marktplatz is not null
   order by 1
$function$;

revoke all on function internal.ads_aktive_marktplaetze(uuid) from public, anon, authenticated;
grant execute on function internal.ads_aktive_marktplaetze(uuid) to service_role;

comment on function internal.ads_aktive_marktplaetze(uuid) is
  'Marktplaetze mit freigeschaltetem Werbe-Profil. Leer = Mandant laeuft im Einprofil-Modus wie vor dem 29.09.2026.';

-- ---------------------------------------------------------------- Struktur-Anstoss mit Land

-- Ueberladung von stosse_ads_struktur_an um den Marktplatz. Die einstellige
-- Fassung bleibt bestehen: sie wird von Hand und aus aelteren Stellen gerufen.
create or replace function internal.stosse_ads_struktur_an(p_tenant_id uuid, p_marktplatz text)
  returns bigint
  language plpgsql security definer set search_path to 'internal', 'public', 'net'
as $function$
declare
  v_url  text := internal.vault_secret('project_url');
  v_key  text := internal.vault_secret('service_role_key');
  v_body jsonb := jsonb_build_object('tenant_id', p_tenant_id);
begin
  if v_url is null or v_key is null then
    raise exception 'Vault-Secrets project_url und/oder service_role_key fehlen.';
  end if;
  -- NULL heisst bewusst "kein Marktplatz im Body" — die Function faellt dann auf
  -- das verbundene Profil zurueck. Ein leerer String wuerde dort als Wunsch
  -- gelesen und mit 404 quittiert.
  if p_marktplatz is not null then
    v_body := v_body || jsonb_build_object('marktplatz', p_marktplatz);
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/sync-ads-struktur',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := v_body,
    timeout_milliseconds := 150000
  );
end $function$;

revoke all on function internal.stosse_ads_struktur_an(uuid, text) from public, anon, authenticated;
grant execute on function internal.stosse_ads_struktur_an(uuid, text) to service_role;

-- ---------------------------------------------------------------- Tageslauf Berichte

create or replace function internal.cron_ads_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare
  r      record;
  mp     text;
  laender text[];
  n      int := 0;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    select coalesce(array_agg(m), array[]::text[])
      into laender
      from internal.ads_aktive_marktplaetze(r.tenant_id) m;

    -- Kein freigeschaltetes Profil: exakt der alte Weg, ein Durchgang ohne Land.
    if array_length(laender, 1) is null then
      laender := array[null::text];
    end if;

    foreach mp in array laender loop
      begin
        perform internal.stosse_ads_sync_an(
          r.tenant_id,
          jsonb_strip_nulls(jsonb_build_object('days', 30, 'marktplatz', mp)));
        perform internal.stosse_ads_sync_an(
          r.tenant_id,
          jsonb_strip_nulls(jsonb_build_object('report_type', 'sp-search-term', 'days', 14, 'marktplatz', mp)));
        perform internal.stosse_ads_sync_an(
          r.tenant_id,
          jsonb_strip_nulls(jsonb_build_object('report_type', 'sp-placement', 'days', 14, 'marktplatz', mp)));
        n := n + 1;
      exception when others then
        -- Ein Land darf die anderen nicht mitreissen.
        raise warning 'ads-sync % / % fehlgeschlagen: %', r.tenant_id, coalesce(mp,'(verbundenes Profil)'), sqlerrm;
      end;
    end loop;
  end loop;
  return n;
end $function$;

comment on function internal.cron_ads_alle_tenants() is
  'Taeglicher Ads-Berichtslauf je Mandant UND je freigeschaltetem Werbe-Profil. Rueckgabe = Zahl der angestossenen Laeufe, nicht der Mandanten.';

-- ---------------------------------------------------------------- Tageslauf Struktur

create or replace function internal.cron_ads_struktur_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare
  r      record;
  mp     text;
  laender text[];
  n      int := 0;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    select coalesce(array_agg(m), array[]::text[])
      into laender
      from internal.ads_aktive_marktplaetze(r.tenant_id) m;

    if array_length(laender, 1) is null then
      laender := array[null::text];
    end if;

    foreach mp in array laender loop
      begin
        perform internal.stosse_ads_struktur_an(r.tenant_id, mp);
        n := n + 1;
      exception when others then
        raise warning 'ads-struktur % / % fehlgeschlagen: %', r.tenant_id, coalesce(mp,'(verbundenes Profil)'), sqlerrm;
      end;
    end loop;
  end loop;
  return n;
end $function$;

comment on function internal.cron_ads_struktur_alle_tenants() is
  'Taeglicher Struktur-Snapshot je Mandant UND je freigeschaltetem Werbe-Profil.';

notify pgrst, 'reload schema';

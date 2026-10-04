-- Sechs Ads-Berichte liefen seit dem 29.09.2026 nicht mehr.
--
-- Die Migration 20260929120000_ads_cron_je_profil hat cron_ads_alle_tenants auf
-- "je Werbe-Profil" umgestellt und dabei nur drei Berichte uebernommen
-- (Advertised Product, Suchbegriffe, Platzierungen). Die uebrigen sechs aus
-- 20260910093021_ads_cron_brands_display fielen weg — ohne Fehlermeldung, sie
-- wurden schlicht nicht mehr angefordert:
--
--   sp-targeting           -> ads_ziele_daily: Grundlage fuer Ads-Changelog,
--                             Gebotsautomatik und die Wirkung neuer Keywords
--   sb-search-term, sb-targeting, sd-targeting
--   sb-campaigns, sd-advertised-product
--                          -> Kosten von Sponsored Brands und Display im Ergebnis
--
-- Aufgefallen am 04.10.2026: ads_ziele_daily endete am 25.09., waehrend die
-- Suchbegriffe bis zum 01.10. reichten. Die Sync-Wache schlug nicht an — sie
-- meldet Fehlschlaege, nicht Abwesenheit (siehe pulse-uebergabe.md).
--
-- Die drei direkten Anstoesse bleiben, wie sie sind. Die sechs fehlenden gehen
-- wie frueher in die Warteschlange (ein Bericht je Mandant alle zwei Minuten,
-- wegen Amazons 429ern) — jetzt mit Marktplatz.
create or replace function internal.cron_ads_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare
  r      record;
  mp     text;
  t      text;
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
        foreach t in array array[
          'sp-targeting', 'sb-search-term', 'sb-targeting', 'sd-targeting',
          'sd-advertised-product', 'sb-campaigns'
        ] loop
          perform internal.ads_report_einstellen(
            r.tenant_id,
            jsonb_strip_nulls(jsonb_build_object('report_type', t, 'days', 14, 'marktplatz', mp)));
        end loop;
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
  'Taeglicher Ads-Berichtslauf je Mandant UND je freigeschaltetem Werbe-Profil: drei Berichte direkt, sechs ueber die Warteschlange. Rueckgabe = Zahl der angestossenen Laeufe, nicht der Mandanten.';

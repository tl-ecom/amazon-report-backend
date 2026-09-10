-- Sponsored Brands und Display in den taeglichen Ads-Lauf aufnehmen.
--
-- Bisher holte Pulse als KOSTENQUELLE nur Sponsored Products. Die uebrigen
-- Reports (sb-search-term, sd-targeting) liefern zwar Suchbegriffe und Ziele,
-- aber keine Tagesreihe — die Kosten landeten nie in ads_daily.
--
-- Aufgefallen beim Sellerboard-Abgleich: 9.494 € statt 11.586 € fuer Vanejas
-- August. Die fehlenden 18 % sind Brands (1.313 €), Brands Video (377 €) und
-- Display (30 €). Das verzerrt TACOS, ACOS, den Break-even und jede
-- Ertragsrechnung nach Werbung — ueberall dort war die Werbung zu billig.
create or replace function internal.cron_ads_alle_tenants()
returns integer
language plpgsql
security definer
set search_path to 'internal', 'public'
as $function$
declare r record; n int := 0; t text;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    begin
      -- Sponsored Products, Tagesreihe (eigener Weg, siehe sync_ads_jetzt).
      perform public.sync_ads_jetzt(r.tenant_id);
      foreach t in array array[
        'sp-search-term','sp-placement','sp-targeting',
        'sb-search-term','sb-targeting','sd-targeting',
        -- Neu: die beiden fehlenden Kostenquellen. Sie schreiben in dieselbe
        -- Tagesreihe wie Sponsored Products, unterschieden durch ad_product.
        'sd-advertised-product','sb-campaigns'
      ] loop
        perform internal.ads_report_einstellen(r.tenant_id, jsonb_build_object('report_type', t, 'days', 14));
      end loop;
      n := n + 1;
    exception when others then raise warning 'ads-sync % fehlgeschlagen: %', r.tenant_id, sqlerrm; end;
  end loop;
  return n;
end $function$;;

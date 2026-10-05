-- Vaneja: 340 Zeilen franzoesischer Kampagnen standen in ads_daily unter dem
-- deutschen Marktplatz (geschrieben am 14.09.2026 09:15, als `marktplatz`
-- Teil des Schluessels wurde; Zeitraum 12.08.–11.09.2026). Jede deutsche
-- Ads-Auswertung, die so weit zurueckreicht, zaehlte 330 EUR Kosten und
-- 900 EUR Werbeumsatz aus Frankreich mit. Vom Nutzer am 05.10.2026 freigegeben.
--
-- Franzoesisch ist eine Kampagne, die es unter dem franzoesischen Marktplatz
-- gibt — Kampagnen-IDs sind je Werbeprofil eindeutig.
--   * Zeile gibt es mit gleichem Schluessel schon unter Frankreich -> loeschen.
--   * Sonst (12.–26.08., nur falsch beschriftet)                   -> umschreiben.
-- Vorher gesichert in internal.ads_daily_fr_unter_de_20261005; zurueck ginge
-- es mit: Zeilen dieser Kampagnen/Tage entfernen und die Sicherung einfuegen.
--
-- Ergebnis am 05.10.2026: 174 geloescht, 166 umgeschrieben.
create table internal.ads_daily_fr_unter_de_20261005 as
select d.*
  from public.ads_daily d
 where d.tenant_id = '4c331e70-809d-4590-a587-1e917f9db6ca'
   and d.marktplatz = 'A1PA6795UKMFR9'
   and d.campaign_id in (select campaign_id from public.ads_daily
                          where tenant_id = '4c331e70-809d-4590-a587-1e917f9db6ca'
                            and marktplatz = 'A13V1IB3VIYZZH');

do $$
declare
  n_sicher int; n_weg int; n_um int;
begin
  select count(*) into n_sicher from internal.ads_daily_fr_unter_de_20261005;
  if n_sicher <> 340 then
    raise exception 'Erwartet 340 Zeilen, gefunden % — nichts geaendert.', n_sicher;
  end if;

  delete from public.ads_daily d
   using internal.ads_daily_fr_unter_de_20261005 s
   where d.tenant_id = s.tenant_id and d.marktplatz = s.marktplatz and d.ad_product = s.ad_product
     and d.datum = s.datum and d.campaign_id = s.campaign_id and d.ad_group_id = s.ad_group_id
     and d.asin = s.asin and d.sku = s.sku
     and exists (select 1 from public.ads_daily f
                  where f.tenant_id = s.tenant_id and f.marktplatz = 'A13V1IB3VIYZZH' and f.ad_product = s.ad_product
                    and f.datum = s.datum and f.campaign_id = s.campaign_id and f.ad_group_id = s.ad_group_id
                    and f.asin = s.asin and f.sku = s.sku);
  get diagnostics n_weg = row_count;

  update public.ads_daily d set marktplatz = 'A13V1IB3VIYZZH'
    from internal.ads_daily_fr_unter_de_20261005 s
   where d.tenant_id = s.tenant_id and d.marktplatz = s.marktplatz and d.ad_product = s.ad_product
     and d.datum = s.datum and d.campaign_id = s.campaign_id and d.ad_group_id = s.ad_group_id
     and d.asin = s.asin and d.sku = s.sku;
  get diagnostics n_um = row_count;

  if n_weg + n_um <> 340 then
    raise exception 'Geloescht % + umgeschrieben % <> 340 — zurueckgerollt.', n_weg, n_um;
  end if;
  raise notice 'ads_daily: % Doppelte geloescht, % auf Frankreich umgeschrieben.', n_weg, n_um;
end $$;

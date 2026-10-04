-- ads_changelog liest je Aenderung zehnmal die Tagesreihe EINES Ziels
-- (Fenster davor/danach). Der Primaerschluessel beginnt mit
-- (tenant_id, marktplatz, ad_product, datum, ...) und hilft dabei nicht: jede
-- dieser Abfragen lief ueber alle Tage des Mandanten. Mit 71.678 Zeilen bei
-- Vaneja lief die Funktion am 04.10.2026 in das Statement-Timeout — das
-- Werkzeug get_ads_changelog antwortete gar nicht mehr.
create index if not exists ads_ziele_daily_je_ziel
  on public.ads_ziele_daily (tenant_id, ziel_id, datum);

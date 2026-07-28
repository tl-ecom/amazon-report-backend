-- Listings-Report in den täglichen Scheduler aufnehmen.
--
-- GET_MERCHANT_LISTINGS_ALL_DATA ist ein Snapshot (kein Zeitraum). Der days-Wert
-- ist für sync-report bei snapshot-Reports bedeutungslos, wird hier aber wegen
-- des CHECK-Constraints (1..90) auf 1 gesetzt.
--
-- FBA-Inventory wird BEWUSST NICHT aufgenommen: der Report ist mit den aktuellen
-- App-Rollen gesperrt (siehe UEBERGABE.md). Sobald die Rolle "Amazon Fulfillment"
-- angehakt ist, kann er per weiterem insert nachgezogen werden.

insert into internal.scheduler_reports (report_type, days, aktiv) values
  ('GET_MERCHANT_LISTINGS_ALL_DATA', 1, true)
on conflict (report_type) do nothing;

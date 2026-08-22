-- FBA-Bestandsbericht in den taeglichen Sync aufnehmen. Momentaufnahme, kein
-- Zeitraum. Bei Tenants ohne Inventory-Rolle schlaegt er mit 403 fehl — das
-- bleibt ein Fehler dieses einen Reports und stoppt die uebrigen nicht.
insert into internal.scheduler_reports (report_type, aktiv)
values ('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', true)
on conflict (report_type) do update set aktiv = true;;

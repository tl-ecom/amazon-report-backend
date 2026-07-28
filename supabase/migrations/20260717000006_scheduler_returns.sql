-- Retouren-Report in den täglichen Scheduler aufnehmen.
--
-- GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE ist zeitraumbasiert (max 30 Tage).
-- Ab jetzt werden Retouren automatisch gesammelt — auch wenn aktuell keine
-- anfallen, ist das Feld dann gefüllt, sobald welche kommen.

insert into internal.scheduler_reports (report_type, days, aktiv) values
  ('GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE', 30, true)
on conflict (report_type) do nothing;

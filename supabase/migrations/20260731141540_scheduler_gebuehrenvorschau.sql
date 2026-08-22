-- Gebührenvorschau in den täglichen Report-Zeitplan aufnehmen.
-- days = 1, weil es eine Momentaufnahme ohne Zeitraum ist (wie der Listings- und
-- der FBA-Bestandsbericht).
insert into internal.scheduler_reports (report_type, days, aktiv)
values ('GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA', 1, true)
on conflict (report_type) do update set aktiv = true;;

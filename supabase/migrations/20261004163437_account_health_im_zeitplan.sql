-- Account Health taeglich ziehen. Momentaufnahme: days ist bedeutungslos, die
-- Spalte verlangt aber einen Wert zwischen 1 und 90.
insert into internal.scheduler_reports (report_type, days)
values ('GET_V2_SELLER_PERFORMANCE_REPORT', 1)
on conflict (report_type) do nothing;

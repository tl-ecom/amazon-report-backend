-- FBA-Kundenretouren in den täglichen Report-Sync aufnehmen (30-Tage-Fenster).
insert into internal.scheduler_reports (report_type, days)
values ('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', 30)
on conflict (report_type) do update set days = excluded.days;;

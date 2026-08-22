-- Abrechnungsbericht in den Zeitplan. Amazon erzeugt je Auszahlung einen neuen;
-- der Lauf holt jeweils den jüngsten fertigen. Über die Zeit sammeln sich so
-- alle Zeiträume und Marktplätze an, ohne dass jemand nachfassen muss.
-- Das hält auch die USt.-Messung mit frischen Buchungen versorgt.
insert into internal.scheduler_reports (report_type, days, aktiv)
values ('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 1, true)
on conflict (report_type) do update set aktiv = true;;

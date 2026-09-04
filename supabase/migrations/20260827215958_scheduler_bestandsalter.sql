-- Das Bestandsalter (fba_bestandsalter) speist Lagerkosten, Ladenhueter und die
-- Trennung frisch/alt bei den Lagergebuehren. Der Report lief GENAU EINMAL —
-- am 31.07.2026 von Hand — und stand seither in keinem Zeitplan. Vanejas
-- Bestandsalter war damit 27 Tage alt, ohne dass irgendwo etwas fehlschlug:
-- es passierte einfach nichts.
--
-- GET_FBA_INVENTORY_PLANNING_DATA ist eine Momentaufnahme (snapshot: true in
-- der sync-report-Konfiguration); `days` ist hier ohne Wirkung und steht nur
-- der Einheitlichkeit halber auf 1, wie bei der Gebuehrenvorschau.

insert into internal.scheduler_reports (report_type, days, aktiv)
values ('GET_FBA_INVENTORY_PLANNING_DATA', 1, true)
on conflict (report_type) do update set aktiv = true;;

-- report_data haelt den Rohreport. "Der aktuellste Report je Typ" war bisher
-- eindeutig, weil es nur einen Marktplatz gab. Mit einem zweiten Ads-Profil
-- wuerde der franzoesische Report den deutschen als `is_latest` verdraengen —
-- und die Uebersicht zeigte danach franzoesische Zahlen unter deutschem Namen.
alter table public.report_data add column if not exists marktplatz text;

-- Bestand: SP- und Ads-Zeilen bekommen den Marktplatz ihrer Verbindung.
update public.report_data r
   set marktplatz = ac.marketplace_id
  from public.auth_contexts ac
 where ac.tenant_id = r.tenant_id and ac.source = r.source and r.marktplatz is null;

update public.report_data set marktplatz = 'A1PA6795UKMFR9' where marktplatz is null;

drop index if exists public.one_latest_per_report;
create unique index one_latest_per_report
  on public.report_data (tenant_id, source, report_type, marktplatz)
  where is_latest;

drop index if exists public.idx_report_data_latest;
create index idx_report_data_latest
  on public.report_data (tenant_id, source, report_type, marktplatz)
  where is_latest;

comment on column public.report_data.marktplatz is
  'Marketplace-ID, fuer die dieser Report geholt wurde. Teil der Eindeutigkeit von is_latest.';

notify pgrst, 'reload schema';;

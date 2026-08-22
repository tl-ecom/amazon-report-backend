-- Rate Card DE S. 8: "Für Produkte in Paketgröße in ausgewählten Kategorien".
-- Anderes Gebührenmodell als S. 6: Grundgebühr für die ersten 100 g plus
-- Zuschlag je weitere 100 g. Deshalb zwei eigene Spalten statt fee_eur —
-- fee_eur wäre hier eine Vereinfachung, die falsche Beträge erzeugen würde.
alter table public.fee_schedule add column if not exists grundgebuehr_eur numeric;
alter table public.fee_schedule add column if not exists zuschlag_je_100g_eur numeric;

comment on column public.fee_schedule.grundgebuehr_eur is
  'Nur fuer die Kategorietabellen (Rate Card S. 8): Grundgebuehr fuer die ersten 100 g.';
comment on column public.fee_schedule.zuschlag_je_100g_eur is
  'Nur fuer die Kategorietabellen: Zuschlag je weitere angefangene 100 g.';

delete from public.fee_schedule
where marketplace = 'DE' and gueltig_ab = '2026-07-01' and grundgebuehr_eur is not null;

insert into public.fee_schedule (
  marketplace, size_tier, amazon_klasse_de,
  max_longest_side_cm, max_median_side_cm, max_shortest_side_cm,
  max_weight_g, grundgebuehr_eur, zuschlag_je_100g_eur, gueltig_ab, quelle, hinweis
) values
('DE','SmallParcel1','Kleines Paket 1',       35,25, 7, 3900, 3.30, 0.05,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g'),
('DE','SmallParcel2','Kleines Paket 2',       35,25, 9, 3900, 3.34, 0.06,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g'),
('DE','SmallParcel3','Kleines Paket 3',       35,25,12, 3900, 3.38, 0.07,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g'),
('DE','MediumParcel1','Mittelgroßes Paket 1', 40,30, 6,11900, 3.50, 0.07,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g'),
('DE','MediumParcel2','Mittelgroßes Paket 2', 40,30,20,11900, 3.73, 0.07,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g'),
('DE','LargeParcel1','Großes Paket 1',        45,34,10,11900, 3.97, 0.07,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g'),
('DE','LargeParcel2','Großes Paket 2',        45,34,26,11900, 4.38, 0.08,'2026-07-01','ratecard-de-2026-07 S.8','Grundgebuehr + Zuschlag je 100 g');;

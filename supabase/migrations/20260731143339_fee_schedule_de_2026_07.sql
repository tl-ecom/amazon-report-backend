-- FBA Rate Card DE, gültig ab 01.07.2026, Seite 6 ("Standardversand durch
-- Amazon — Inländische FBA, MCI, paneuropäisch"), Spalte "Nur DE (€)".
-- Übernommen aus dem PDF, das TL bereitgestellt hat. Keine Zahl geschätzt.
--
-- Achtung beim Vergleich mit gemessenen Gebühren: Seit 17.04.2026 erhebt Amazon
-- zusätzlich 1,5 % Treibstoff- und Logistikaufschlag auf die Versandgebühr. Die
-- Beträge hier sind OHNE diesen Aufschlag.

alter table public.fee_schedule add column if not exists hinweis text;
alter table public.fee_schedule add column if not exists amazon_klasse_de text;

delete from public.fee_schedule where marketplace = 'DE' and gueltig_ab = '2026-07-01';

insert into public.fee_schedule (
  marketplace, size_tier, amazon_klasse_de,
  max_longest_side_cm, max_median_side_cm, max_shortest_side_cm,
  max_weight_g, fee_eur, gueltig_ab, quelle
) values
-- Umschläge (Gebühr nach Stückgewicht, kein Volumengewicht)
('DE','LightEnvelope','Leichter Umschlag',        33,23,2.5,   20, 2.33,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','LightEnvelope','Leichter Umschlag',        33,23,2.5,   40, 2.37,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','LightEnvelope','Leichter Umschlag',        33,23,2.5,   60, 2.39,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','LightEnvelope','Leichter Umschlag',        33,23,2.5,   80, 2.52,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','LightEnvelope','Leichter Umschlag',        33,23,2.5,  100, 2.54,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardEnvelope','Standardumschlag',      33,23,2.5,  210, 2.57,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardEnvelope','Standardumschlag',      33,23,2.5,  460, 2.68,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','LargeEnvelope','Großer Umschlag',          33,23,4,    960, 3.04,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','ExtraLargeEnvelope','Extra großer Umschlag',33,23,6,   960, 3.42,'2026-07-01','ratecard-de-2026-07 S.6'),
-- Kleines Paket: 35 x 25 x 12 cm, Stückgewicht <= 3,90 kg, Volumengewicht <= 2,10 kg
('DE','SmallParcel','Kleines Paket',              35,25,12,   150, 3.38,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','SmallParcel','Kleines Paket',              35,25,12,   400, 3.39,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','SmallParcel','Kleines Paket',              35,25,12,   900, 3.40,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','SmallParcel','Kleines Paket',              35,25,12,  1400, 3.41,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','SmallParcel','Kleines Paket',              35,25,12,  1900, 3.43,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','SmallParcel','Kleines Paket',              35,25,12,  3900, 4.54,'2026-07-01','ratecard-de-2026-07 S.6'),
-- Standardpaket: 45 x 34 x 26 cm, Stückgewicht <= 11,90 kg, Volumengewicht <= 7,96 kg
('DE','StandardParcel','Standardpaket',           45,34,26,   150, 3.39,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,   400, 3.42,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,   900, 3.44,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,  1400, 3.93,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,  1900, 3.95,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,  2900, 4.55,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,  3900, 5.09,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,  5900, 5.22,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26,  8900, 6.03,'2026-07-01','ratecard-de-2026-07 S.6'),
('DE','StandardParcel','Standardpaket',           45,34,26, 11900, 6.65,'2026-07-01','ratecard-de-2026-07 S.6');

comment on column public.fee_schedule.amazon_klasse_de is
  'Deutscher Name der Klasse aus der Rate Card. size_tier ist der englische Schluessel, den die API liefert.';;

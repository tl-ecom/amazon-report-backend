-- Niedrigpreisversand DE, Rate Card S. 5, Spalte "Nur DE", gültig ab 01.07.2026.
--
-- Eine eigene Tabelle, kein Rabatt auf die Standardtabelle. Sie deckt NUR die
-- kleinen Klassen ab — Umschläge und Kleines Paket bis 400 g. Ein günstiger
-- Artikel in einer größeren Klasse ist nicht qualifiziert und läuft über den
-- Standardtarif; genau das leitet der Code aus dem Fehlen der Zeile ab.
--
-- Gegenprobe an Vanejas gebuchten Gebühren (Tabelle / von Amazon berechnet):
--   Großer Umschlag 170 g        2,65 / 2,66
--   Standardumschlag 340 g       2,28 / 2,29
--   Extra großer Umschlag 410 g  3,04 / 3,03
-- Der Treibstoffaufschlag von 1,5 % ist hier NICHT enthalten und wird auf diese
-- Zeilen auch nicht gerechnet — mit ihm lägen die Werte 4 Cent daneben.

insert into public.fee_schedule (marketplace, tarif, preis_grenze_cents, size_tier, amazon_klasse_de,
  max_longest_side_cm, max_median_side_cm, max_shortest_side_cm, max_weight_g, fee_eur,
  gueltig_ab, quelle, hinweis, updated_at)
values
 ('DE','niedrigpreis',2000,'LightEnvelope','Leichter Umschlag',33,23,2.5,20,1.87,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'LightEnvelope','Leichter Umschlag',33,23,2.5,40,1.90,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'LightEnvelope','Leichter Umschlag',33,23,2.5,60,1.92,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'LightEnvelope','Leichter Umschlag',33,23,2.5,80,2.06,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'LightEnvelope','Leichter Umschlag',33,23,2.5,100,2.09,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'StandardEnvelope','Standardumschlag',33,23,2.5,210,2.12,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'StandardEnvelope','Standardumschlag',33,23,2.5,460,2.28,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'LargeEnvelope','Großer Umschlag',33,23,4,960,2.65,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'ExtraLargeEnvelope','Extra großer Umschlag',33,23,6,960,3.04,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'SmallParcel','Kleines Paket',35,25,12,150,3.04,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now()),
 ('DE','niedrigpreis',2000,'SmallParcel','Kleines Paket',35,25,12,400,3.25,'2026-07-01','ratecard-de-2026-07 S.5','Niedrigpreisversand: ohne Volumengewicht (S.5 Fn.1)',now())
on conflict (marketplace, tarif, size_tier, gueltig_ab, max_weight_g) do update
  set fee_eur = excluded.fee_eur,
      preis_grenze_cents = excluded.preis_grenze_cents,
      amazon_klasse_de = excluded.amazon_klasse_de,
      max_longest_side_cm = excluded.max_longest_side_cm,
      max_median_side_cm = excluded.max_median_side_cm,
      max_shortest_side_cm = excluded.max_shortest_side_cm,
      quelle = excluded.quelle,
      hinweis = excluded.hinweis,
      updated_at = now();

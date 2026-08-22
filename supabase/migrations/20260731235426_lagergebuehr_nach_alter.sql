-- Coaching-Regel: Lagerung 1.–3. Monat ist der Preis des Verkaufens,
-- ab dem 4. Monat selbst erzeugt. Zwei Typen statt einem.
delete from public.fee_type_classification where fee_typ = 'FBALagergebuehrBasis';

insert into public.fee_type_classification
  (fee_typ, label, steuerbar, hebel, massnahme, hinweis, quelle)
values
  ('FBALagergebuehrBis3Monate', 'Lagergebühr, 1.–3. Monat', false, null, null,
   'Ware muss liegen, bevor sie verkauft wird. Die ersten drei Monate sind der Preis des Verkaufens.',
   'coaching-regel'),
  ('FBALagergebuehrAb4Monate', 'Lagergebühr ab dem 4. Monat', true, 'operations',
   'Bestand älter als drei Monate abbauen: Nachbestellmengen senken, Abverkauf anschieben, notfalls auslagern.',
   'Anteil nach Menge aufgeteilt — Amazon weist die Lagergebühr nicht je Altersstufe aus.',
   'coaching-regel')
on conflict (fee_typ) do update set
  label = excluded.label, steuerbar = excluded.steuerbar, hebel = excluded.hebel,
  massnahme = excluded.massnahme, hinweis = excluded.hinweis;;

-- Die Lagergebühren kommen nicht als "fee_typ" aus der Abrechnung, sondern als
-- eigene Spalten im Lagerbericht. Für Modul 1 bekommen sie deshalb zwei
-- ausdrückliche Typen — synthetisch, aber sprechend.
insert into public.fee_type_classification
  (fee_typ, label, steuerbar, hebel, massnahme, hinweis, quelle)
values
  ('FBALagernutzungszuschlag', 'Lagernutzungszuschlag', true, 'operations',
   'Verhältnis Lagervolumen zu Abverkauf senken: Überbestand abbauen, Anliefermengen takten.',
   'Greift ab einem Lagernutzungsgrad über 22 Wochen (Rate Card S. 4).', 'brief'),
  -- Basis-Lagergebühr steht in KEINER der beiden Listen des Briefings.
  -- Sie ist echt zweideutig: Lagern muss man, WIE VIEL man lagert ist aber eine
  -- Entscheidung. Deshalb bewusst offen — TL entscheidet, nicht die App.
  ('FBALagergebuehrBasis', 'Lagergebühr (Basis)', null, null, null,
   'Im Briefing weder als steuerbar noch als unvermeidbar geführt. Lagern ist Pflicht, die Menge nicht — bitte einordnen.',
   'beobachtet')
on conflict (fee_typ) do update set
  label = excluded.label, hinweis = excluded.hinweis;;

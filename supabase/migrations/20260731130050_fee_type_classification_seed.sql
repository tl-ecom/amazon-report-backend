-- Seed der Gebühren-Klassifizierung.
-- Zwei Quellen, klar getrennt:
--   quelle='brief'      -> so im Spec festgelegt (steuerbar/nicht steuerbar + Hebel)
--   quelle='beobachtet' -> Typ taucht real in finance_gebuehren auf, ist aber im
--                          Brief nicht klassifiziert -> steuerbar bleibt NULL,
--                          landet im 'unclassified'-Bucket + Admin-Hinweis.
-- NICHTS wird geraten: unklare Typen bleiben bewusst unklassifiziert.

-- (A) Nicht steuerbar — laut Brief "Naturgesetz", wird ausgewiesen, nicht bewertet.
insert into public.fee_type_classification (fee_typ, label, steuerbar, hebel, massnahme, hinweis, quelle) values
  ('Commission', 'Verkaufsgebühr (Referral Fee)', false, null, null,
   'Nicht steuerbar: prozentuale Kategoriegebühr von Amazon.', 'brief'),
  ('FBAPerUnitFulfillmentFee', 'FBA-Versandgebühr (Basis)', false, null, null,
   'Nicht steuerbar in der Höhe — die Größenklasse ist es aber (siehe Modul 2).', 'brief')
on conflict (fee_typ) do nothing;

-- (B) Steuerbar — laut Brief operativ verursacht, mit Hebel-Zuordnung.
--     ACHTUNG: Die exakten Amazon-Bezeichnungen sind bei diesem Konto noch NICHT
--     aufgetreten. Die Schlüssel sind daher vorläufig und werden beim ersten
--     Auftreten gegen die echte Bezeichnung abgeglichen (Admin-Hinweis).
insert into public.fee_type_classification (fee_typ, label, steuerbar, hebel, hebel_alternativ, massnahme, hinweis, quelle) values
  ('FBALowInventoryLevelFee', 'Low-Inventory-Level-Fee', true, 'operations', null,
   'Bestandsreichweite über die Schwelle heben — Nachbestellrhythmus und Sicherheitsbestand prüfen.',
   'Exakte Amazon-Bezeichnung noch nicht beobachtet — beim ersten Auftreten abgleichen.', 'brief'),
  ('FBAInboundPlacementServiceFee', 'Inbound Placement Service Fee', true, 'operations', null,
   'Anlieferung auf mehrere Verteilzentren aufteilen statt Einzelstandort — Placement-Option beim Shipment prüfen.',
   'Exakte Amazon-Bezeichnung noch nicht beobachtet — beim ersten Auftreten abgleichen.', 'brief'),
  ('FBAStorageUtilizationSurcharge', 'Storage Utilization Surcharge', true, 'operations', null,
   'Verhältnis Lagervolumen zu Abverkauf senken — Überbestand abbauen, Anliefermengen takten.',
   'Exakte Amazon-Bezeichnung noch nicht beobachtet — beim ersten Auftreten abgleichen.', 'brief'),
  ('FBAAgedInventorySurcharge', 'Aged Inventory Surcharge', true, 'operations', null,
   'Altbestand vor Erreichen der Altersstufe abverkaufen oder entfernen.',
   'Exakte Amazon-Bezeichnung noch nicht beobachtet — beim ersten Auftreten abgleichen.', 'brief'),
  ('FBALongTermStorageFee', 'Langzeitlagergebühr', true, 'operations', null,
   'Langlieger auslagern oder abverkaufen, bevor die Langzeitgebühr greift.',
   'Exakte Amazon-Bezeichnung noch nicht beobachtet — beim ersten Auftreten abgleichen.', 'brief'),
  ('FBARemovalFee', 'Removal / Disposal', true, 'operations', null,
   'Entfernungen bündeln und Ursache prüfen: warum musste der Bestand raus?',
   'Exakte Amazon-Bezeichnung noch nicht beobachtet — beim ersten Auftreten abgleichen.', 'brief'),
  -- Returns Processing: Hebel NICHT automatisch bestimmbar -> zwei Hypothesen.
  ('FBAReturnsProcessingFee', 'Returns Processing Fee', true, 'content', 'produkt_market_fit',
   'Retourengründe auswerten: Erwartungslücke (Bilder/Bullets/Maße schärfen) oder Qualitätsproblem (Produkt/Verpackung).',
   'Hebel aus Gebührendaten allein nicht bestimmbar — Retourengrund heranziehen, sonst beide Hypothesen zeigen.', 'brief')
on conflict (fee_typ) do nothing;

-- (C) Real beobachtet, im Brief nicht klassifiziert -> bewusst OFFEN lassen.
insert into public.fee_type_classification (fee_typ, label, steuerbar, hinweis, quelle) values
  ('RefundCommission', 'Erstattete/​einbehaltene Verkaufsgebühr bei Retoure', null,
   'Im Brief nicht klassifiziert — bitte entscheiden: steuerbar (Retourenquote) oder nicht.', 'beobachtet'),
  ('ShippingChargeback', 'Versand-Rückbelastung', null,
   'Im Brief nicht klassifiziert — bitte entscheiden.', 'beobachtet'),
  ('DigitalServicesFee', 'Digital Services Fee', null,
   'Regulatorischer Aufschlag auf andere Gebühren — vermutlich nicht steuerbar, bitte bestätigen.', 'beobachtet'),
  ('DigitalServicesFeeFBA', 'Digital Services Fee (FBA)', null,
   'Regulatorischer Aufschlag auf die FBA-Gebühr — vermutlich nicht steuerbar, bitte bestätigen.', 'beobachtet'),
  ('GiftwrapChargeback', 'Geschenkverpackung-Rückbelastung', null,
   'Im Brief nicht klassifiziert — bitte entscheiden.', 'beobachtet')
on conflict (fee_typ) do nothing;;

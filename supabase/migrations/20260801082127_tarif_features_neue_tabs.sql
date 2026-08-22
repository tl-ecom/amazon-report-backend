-- Das Frontend gated Tabs ueber sichtFeatures[tab.id] — der Tab-Name IST der
-- Feature-Schluessel. Die Tabs 'masse', 'lager' und 'auszahlungen' hatten keinen
-- Eintrag in der Matrix und waren damit fuer JEDEN Teilnehmer unsichtbar.
-- Admins umgehen das Gating, deshalb ist es beim Bauen nicht aufgefallen.
--
-- Voreinstellung wie beim verwandten 'gebuehren': im Coaching-Tarif an, sonst
-- aus. In der Matrix jederzeit umschaltbar — welche Analysen zum Basis-Umfang
-- gehoeren, ist eine Preisentscheidung und keine technische.
update public.tarif_features
set features = features
  || jsonb_build_object('masse', tarif = 'coaching')
  || jsonb_build_object('lager', tarif = 'coaching')
  || jsonb_build_object('auszahlungen', tarif = 'coaching')
where not (features ? 'masse' and features ? 'lager' and features ? 'auszahlungen');;

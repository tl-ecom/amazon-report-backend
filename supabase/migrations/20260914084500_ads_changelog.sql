-- Ads-Changelog und Tarif-Eintrag. Die Funktion selbst wurde als Migration
-- `ads_changelog` bzw. `ads_changelog_mindestklicks` angewendet; hier steht der
-- Tarif-Teil, damit ein frisches Projekt denselben Stand bekommt.
--
-- Neues Feature kommt deaktiviert in die Matrix. Nur die Coach-Ansicht sieht
-- ohnehin alles; jeder Tarif wird bewusst freigeschaltet, nicht durch Vergessen.
update public.tarif_features
   set features = features || jsonb_build_object('ads_changelog', false),
       updated_at = now()
 where not (features ? 'ads_changelog');

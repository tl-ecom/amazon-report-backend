-- Einkaufspreise sind jetzt ein eigener Menüpunkt mit eigenem Feature-Key.
-- Startwert = der bisherige "verlauf"-Wert, damit NIEMAND Zugriff verliert
-- (dort lag die EK-Pflege bisher).
update public.tarif_features
set features = features || jsonb_build_object('ek', coalesce(features->'verlauf', 'true'::jsonb));;

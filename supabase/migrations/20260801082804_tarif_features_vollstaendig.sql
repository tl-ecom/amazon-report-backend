-- Alle schaltbaren Menuepunkte in der Matrix fuehren.
--
-- Der Tab-Name ist der Feature-Schluessel (sichtFeatures[tab.id]). Fehlt ein
-- Schluessel, ist der Tab fuer JEDEN Teilnehmer unsichtbar — ohne Fehlermeldung,
-- weil Admins das Gating umgehen. Diese Liste haelt beides zusammen.
--
-- Nicht gefuehrt und immer erlaubt: pulse (Uebersicht), connect, admin, mein_konto.
--
-- Nur FEHLENDE Schluessel werden ergaenzt; bestehende Einstellungen bleiben.
-- Voreinstellung: im Coaching-Tarif an, sonst aus — die Zuordnung, welche
-- Funktion zum Basis-Umfang gehoert, trifft TL in der Matrix.
with schluessel(k) as (
  values ('strategie'),('diagnosen'),('tasks'),('brief'),('board'),('notes'),
         ('aenderungen'),('experimente'),('erstattungen'),('nachschub'),
         ('ladenhueter'),('bestandshistorie'),('ek'),('gebuehren'),('masse'),
         ('lager'),('auszahlungen'),('sqp'),('sales'),('verlauf'),('orders'),
         ('listings'),('ads'),('returns'),('products'),('mcp')
),
fehlend as (
  select t.tarif, s.k
  from public.tarif_features t cross join schluessel s
  where not (t.features ? s.k)
)
update public.tarif_features t
set features = t.features || (
  select coalesce(jsonb_object_agg(f.k, t.tarif = 'coaching'), '{}'::jsonb)
  from fehlend f where f.tarif = t.tarif
)
where exists (select 1 from fehlend f where f.tarif = t.tarif);;

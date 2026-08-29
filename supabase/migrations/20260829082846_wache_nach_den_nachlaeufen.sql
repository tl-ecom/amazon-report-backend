-- Die Wache feuerte, bevor die Reparatur startete.
--
-- Bisherige Reihenfolge:
--   04:30  Hauptlauf
--   06:00  Wache meldet
--   08:30  erster Nachlauf
--   13:30  zweiter Nachlauf
--
-- Damit erzeugte JEDER sprunghafte Ausfall um 04:30 zwangslaeufig eine Mail —
-- auch wenn sich das System zweieinhalb Stunden spaeter von selbst heilte.
-- Genau so kam am 29.08. die Meldung zu GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA,
-- dem bekannten Wackelkandidaten. Die Nachlaeufe vom 22.08. wurden gebaut, um
-- genau das aufzufangen; die Wache wusste nichts davon.
--
-- Dass die Nachlaeufe wirken, zeigt der Verlauf: 09.-12.08. und 15.-18.08. je
-- vier Ausfalltage ohne einen einzigen Erfolg. Seit den Nachlaeufen am 22.08.
-- sechs saubere Tage am Stueck.
--
-- Zwei Aenderungen, jede mit eigener Begruendung:
--
-- 1. Zusaetzlicher Nachlauf um 05:30. Bisher lag zwischen dem Ausfall und dem
--    ersten Reparaturversuch der ganze Vormittag — Nachschub, Ladenhueter und
--    Lagerkosten rechneten bis 08:30 auf dem Vortagesstand. Eine Stunde spaeter
--    ist Amazons Aussetzer meist vorbei.
--
-- 2. Wache von 06:00 auf 14:15, also NACH dem letzten Nachlauf. Was dann noch
--    fehlschlaegt, hat drei Versuche hinter sich und ist eine echte Stoerung.
--    Der Preis: Ein echter Totalausfall wird acht Stunden spaeter gemeldet. Das
--    ist vertretbar, weil die Daten ohnehin taeglich kommen und ein Ausfall bei
--    Amazon nicht schneller behebbar waere — und weil der zweite Zweig der Wache
--    ("seit ueber 36 h kein Erfolg") davon unberuehrt bleibt.

select cron.unschedule('sync-nachzuegler-frueh')
where exists (select 1 from cron.job where jobname = 'sync-nachzuegler-frueh');
select cron.schedule('sync-nachzuegler-frueh', '30 5 * * *',
                     'select internal.cron_sync_nachzuegler()');

select cron.unschedule('sync-wache-taeglich')
where exists (select 1 from cron.job where jobname = 'sync-wache-taeglich');
select cron.schedule('sync-wache-taeglich', '15 14 * * *',
                     'select internal.cron_sync_wache()');

-- Fuenf Definer-Funktionen waren fuer anon und authenticated ausfuehrbar, obwohl ihre
-- eigenen Migrationen bereits "revoke all ... from public" enthielten.
--
-- URSACHE: Supabase hat auf dem Schema public ALTER DEFAULT PRIVILEGES stehen, die bei
-- JEDER neu erzeugten Funktion EXECUTE direkt an anon und authenticated vergeben. Ein
-- "revoke ... from public" entfernt nur das PUBLIC-Recht und laesst den direkten Grant
-- unangetastet — in pg_proc.proacl sichtbar als "anon=X/postgres".
-- Deshalb greift hier nur ein ausdrueckliches "from public, anon, authenticated".
--
-- Das trifft jedes "create or replace": der Durchlauf vom 11.08.2026 war korrekt, die
-- Rechte fielen danach beim Neuanlegen der Funktionen wieder zurueck (ads_backfill_stueckeln
-- am 17.08., betriebskosten_summen/settlement_abdeckung am 18.08., sync_stoerungen am 22.08.).
--
-- Geprueft: Das Frontend ruft KEINE dieser Funktionen auf — es spricht ausschliesslich
-- ueber fetch(/functions/v1/...) mit den Edge Functions, kein einziges .rpc(). Alle
-- Aufrufer (_shared/ads_verlauf.ts, _shared/betriebskosten.ts, _shared/produkte.ts)
-- laufen mit SUPABASE_SERVICE_ROLE_KEY; sync_stoerungen zusaetzlich aus
-- internal.cron_sync_wache() als postgres. service_role umgeht diese ACL ohnehin.

revoke execute on function public.ads_summen(uuid, date, date)            from public, anon, authenticated;
revoke execute on function public.betriebskosten_summen(uuid, date, date) from public, anon, authenticated;
revoke execute on function public.settlement_abdeckung(uuid)              from public, anon, authenticated;
revoke execute on function public.sync_ads_backfill(uuid, integer)        from public, anon, authenticated;
revoke execute on function public.sync_stoerungen(interval)               from public, anon, authenticated;

grant execute on function public.ads_summen(uuid, date, date)            to service_role;
grant execute on function public.betriebskosten_summen(uuid, date, date) to service_role;
grant execute on function public.settlement_abdeckung(uuid)              to service_role;
grant execute on function public.sync_ads_backfill(uuid, integer)        to service_role;
grant execute on function public.sync_stoerungen(interval)               to service_role;

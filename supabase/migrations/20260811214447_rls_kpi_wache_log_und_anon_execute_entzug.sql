alter table public.kpi_wache_log enable row level security;

revoke execute on function public.sync_ads_backfill(uuid, integer) from anon;
revoke execute on function public.korridor_produkte(uuid, text, integer) from anon;
revoke execute on function public.snapshot_paare(uuid, date) from anon;
revoke execute on function public.handle_neuer_nutzer() from anon;;

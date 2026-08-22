-- Aufräum-Cron für den OAuth-Server: entfernt tote Auth-Codes, tote/widerrufene
-- Tokens und verwaiste (dynamisch registrierte) Clients. Reine SQL-DELETEs,
-- keine Edge Function nötig. Läuft täglich 03:45 UTC (freier Slot).
create or replace function internal.cron_oauth_aufraeumen()
returns jsonb
language plpgsql
security definer
set search_path to 'internal', 'public'
as $function$
declare v_codes int; v_tokens int; v_clients int;
begin
  -- 1) Auth-Codes: benutzt (Single-Use) ODER abgelaufen -> weg.
  delete from public.oauth_auth_codes where used or expires_at < now();
  get diagnostics v_codes = row_count;

  -- 2) Tokens: widerrufen ODER Refresh endgültig abgelaufen (dann ist der ganze
  --    Token tot; solange der Refresh lebt, kann der Access erneuert werden).
  delete from public.oauth_tokens
  where revoked or coalesce(refresh_expires_at, access_expires_at) < now();
  get diagnostics v_tokens = row_count;

  -- 3) Verwaiste Clients: älter als 7 Tage und ohne verbleibende Codes/Tokens.
  --    (DCR -> authorize -> token passiert binnen Minuten; 7 Tage sind großzügig.)
  delete from public.oauth_clients c
  where c.created_at < now() - interval '7 days'
    and not exists (select 1 from public.oauth_tokens t where t.client_id = c.client_id)
    and not exists (select 1 from public.oauth_auth_codes a where a.client_id = c.client_id);
  get diagnostics v_clients = row_count;

  return jsonb_build_object('codes', v_codes, 'tokens', v_tokens, 'clients', v_clients, 'at', now());
end $function$;

revoke all on function internal.cron_oauth_aufraeumen() from public, anon, authenticated;

select cron.schedule('oauth-aufraeumen', '45 3 * * *', $$select internal.cron_oauth_aufraeumen();$$);;

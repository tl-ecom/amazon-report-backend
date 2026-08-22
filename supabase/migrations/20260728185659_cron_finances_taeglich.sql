-- Täglich die Amazon-Gebühren aller verbundenen Tenants ziehen (letzte 40 Tage,
-- überlappend -> Upsert je Monat hält die letzten Monate aktuell).
create or replace function internal.cron_finances_alle_tenants()
returns integer language plpgsql security definer set search_path = internal, public, net, vault as $$
declare r record; n int := 0; v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;
  for r in select distinct tenant_id from public.auth_contexts where source = 'sp' and status = 'connected' loop
    perform net.http_post(
      url := v_url || '/functions/v1/sync-finances',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('tenant_id', r.tenant_id, 'tage', 40),
      timeout_milliseconds := 150000
    );
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function internal.cron_finances_alle_tenants() from public, anon, authenticated;

-- Täglich 03:30 UTC (nach dem Report-Sync).
select cron.schedule('sync-finances-taeglich', '30 3 * * *', 'select internal.cron_finances_alle_tenants()');;

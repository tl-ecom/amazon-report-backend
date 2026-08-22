-- Finances für EINEN Tenant sofort anstoßen (für connect-sp / Erst-Connect).
create or replace function public.sync_finances_jetzt(p_tenant uuid)
returns bigint language plpgsql security definer set search_path to 'public','internal','net' as $$
begin
  return net.http_post(
    url := internal.vault_secret('project_url') || '/functions/v1/sync-finances',
    headers := jsonb_build_object('Content-Type','application/json',
               'Authorization','Bearer '||internal.vault_secret('service_role_key')),
    body := jsonb_build_object('tenant_id', p_tenant),
    timeout_milliseconds := 150000
  );
end $$;
revoke execute on function public.sync_finances_jetzt(uuid) from anon, authenticated, public;
grant execute on function public.sync_finances_jetzt(uuid) to service_role;;

-- Ads-Report für EINEN Tenant sofort anstoßen (für connect-ads / Erst-Connect).
create or replace function public.sync_ads_jetzt(p_tenant uuid)
returns bigint language plpgsql security definer set search_path to 'public','internal','net' as $$
begin
  return net.http_post(
    url := internal.vault_secret('project_url') || '/functions/v1/sync-ads-report',
    headers := jsonb_build_object('Content-Type','application/json',
               'Authorization','Bearer '||internal.vault_secret('service_role_key')),
    body := jsonb_build_object('tenant_id', p_tenant, 'days', 30),
    timeout_milliseconds := 150000
  );
end $$;
revoke execute on function public.sync_ads_jetzt(uuid) from anon, authenticated, public;
grant execute on function public.sync_ads_jetzt(uuid) to service_role;

-- Täglicher Ads-Sync: alle Tenants mit source='ads', status='connected'.
create or replace function internal.cron_ads_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $$
declare r record; n int := 0;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active'
  loop
    begin perform public.sync_ads_jetzt(r.tenant_id); n := n + 1;
    exception when others then raise warning 'ads-sync % fehlgeschlagen: %', r.tenant_id, sqlerrm; end;
  end loop;
  return n;
end $$;

select cron.schedule('sync-ads-taeglich', '15 4 * * *', 'select internal.cron_ads_alle_tenants()');;

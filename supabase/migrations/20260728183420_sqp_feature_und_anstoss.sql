-- 'sqp' als Feature in die Tarif-Matrix (nur vip + coaching).
update public.tarif_features set features = jsonb_set(features, '{sqp}', 'true'::jsonb)  where tarif in ('vip','coaching');
update public.tarif_features set features = jsonb_set(features, '{sqp}', 'false'::jsonb) where tarif = 'premium';

-- SQP-Report je ASIN asynchron anstoßen (net.http_post -> sync-sqp, service_role).
create or replace function public.sqp_anstossen(p_tenant uuid, p_asin text)
returns bigint language plpgsql security definer set search_path = public, net, vault as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;
  return net.http_post(
    url := v_url || '/functions/v1/sync-sqp',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('tenant_id', p_tenant, 'asin', p_asin),
    timeout_milliseconds := 150000
  );
end $$;
revoke execute on function public.sqp_anstossen(uuid,text) from anon, authenticated, public;
grant  execute on function public.sqp_anstossen(uuid,text) to service_role;;

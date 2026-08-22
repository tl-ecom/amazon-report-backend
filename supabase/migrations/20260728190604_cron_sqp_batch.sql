-- SQP rate-limit-freundlich: täglich je Firma max 2 der Top-10-ASINs (nach Umsatz),
-- die am längsten nicht synchronisiert wurden (>6 Tage / nie). Über die Woche
-- werden so alle Top-10 frisch, ohne getReportDocument-Limit (~1/min) zu reißen.
create or replace function internal.cron_sqp_batch()
returns integer language plpgsql security definer set search_path = internal, public, net, vault as $$
declare r record; n int := 0; v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets fehlen'; end if;

  for r in (
    with connected as (select distinct tenant_id from public.auth_contexts where source='sp' and status='connected'),
    units as (
      select o.tenant_id, o.asin, sum(o.quantity) q,
             row_number() over (partition by o.tenant_id order by sum(o.quantity) desc) rn
      from public.orders_history o
      join connected c on c.tenant_id = o.tenant_id
      where o.purchase_date::date >= current_date - 90 and o.asin is not null
      group by o.tenant_id, o.asin
    ),
    topn as (select tenant_id, asin, q from units where rn <= 10),
    faellig as (
      select t.tenant_id, t.asin,
        row_number() over (
          partition by t.tenant_id
          order by coalesce((select max(updated_at) from public.sqp_rows s where s.tenant_id=t.tenant_id and s.asin=t.asin), 'epoch'::timestamptz) asc, t.q desc
        ) as prio
      from topn t
      where not exists (
        select 1 from public.sqp_rows s
        where s.tenant_id=t.tenant_id and s.asin=t.asin and s.updated_at > now() - interval '6 days'
      )
    )
    select tenant_id, asin from faellig where prio <= 2
  ) loop
    perform net.http_post(
      url := v_url || '/functions/v1/sync-sqp',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('tenant_id', r.tenant_id, 'asin', r.asin),
      timeout_milliseconds := 150000
    );
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function internal.cron_sqp_batch() from public, anon, authenticated;

-- Täglich 04:00 UTC (nach Finances 03:30).
select cron.schedule('sync-sqp-batch-taeglich', '0 4 * * *', 'select internal.cron_sqp_batch()');;

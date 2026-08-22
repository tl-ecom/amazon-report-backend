-- Sofort-Sync für EINEN Tenant (alle Standard-Reports; für Erst-Connect).
create or replace function public.sync_jetzt(p_tenant uuid)
returns int language plpgsql security definer set search_path to 'public','internal' as $$
declare r record; n int := 0;
begin
  if not exists(select 1 from public.auth_contexts where tenant_id=p_tenant and source='sp' and status='connected') then
    raise exception 'Tenant % ist nicht SP-verbunden', p_tenant;
  end if;
  for r in select report_type, days from internal.scheduler_reports where aktiv loop
    perform internal.stosse_sync_an(p_tenant, jsonb_build_object('report_type', r.report_type, 'days', r.days));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.sync_jetzt(uuid) from anon, authenticated, public;
grant execute on function public.sync_jetzt(uuid) to service_role;

-- 24-Monats-Backfill anstoßen: erzeugt Chunks (idempotent, keine Duplikate).
-- Orders/Retouren(FBM+FBA) = 30-Tage-Fenster; Sales & Traffic = 90-Tage-Fenster.
-- Listings NICHT (nur Snapshot). Bewaehrtes Chunking wie bei e-One.
create or replace function public.backfill_starten(p_tenant uuid, p_monate int default 24)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v_ins int := 0; v_tage int := greatest(1, p_monate) * 30; v_add int;
begin
  if not exists(select 1 from public.auth_contexts where tenant_id=p_tenant and source='sp' and status='connected') then
    raise exception 'Tenant % ist nicht SP-verbunden', p_tenant;
  end if;

  with fenster as (select gs as k from generate_series(0, ceil(v_tage/30.0)::int - 1) gs),
       typen(rt) as (values
         ('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL'),
         ('GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE'),
         ('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA')),
       ins as (
         insert into public.backfill_jobs (tenant_id, report_type, von, bis, status)
         select p_tenant, t.rt,
                (current_date - ((f.k+1)*30))::date, (current_date - (f.k*30))::date, 'pending'
         from fenster f cross join typen t
         where not exists (select 1 from public.backfill_jobs b
           where b.tenant_id=p_tenant and b.report_type=t.rt
             and b.von=(current_date-((f.k+1)*30))::date and b.bis=(current_date-(f.k*30))::date)
         returning 1)
  select count(*) into v_add from ins;
  v_ins := v_ins + v_add;

  with fenster as (select gs as k from generate_series(0, ceil(v_tage/90.0)::int - 1) gs),
       ins as (
         insert into public.backfill_jobs (tenant_id, report_type, von, bis, status)
         select p_tenant, 'GET_SALES_AND_TRAFFIC_REPORT',
                (current_date - ((f.k+1)*90))::date, (current_date - (f.k*90))::date, 'pending'
         from fenster f
         where not exists (select 1 from public.backfill_jobs b
           where b.tenant_id=p_tenant and b.report_type='GET_SALES_AND_TRAFFIC_REPORT'
             and b.von=(current_date-((f.k+1)*90))::date and b.bis=(current_date-(f.k*90))::date)
         returning 1)
  select count(*) into v_add from ins;
  v_ins := v_ins + v_add;

  return v_ins;
end $$;
revoke execute on function public.backfill_starten(uuid,int) from anon, authenticated, public;
grant execute on function public.backfill_starten(uuid,int) to service_role;

-- Generischer Backfill-Treiber: tickt JEDEN Tenant mit offenen Chunks (statt nur e-One).
create or replace function internal.cron_backfill_alle()
returns int language plpgsql security definer set search_path to 'internal','public' as $$
declare r record; n int := 0;
begin
  for r in select distinct tenant_id from public.backfill_jobs where status in ('pending','running') loop
    begin
      perform internal.backfill_tick(r.tenant_id);
      n := n + 1;
    exception when others then
      raise warning 'backfill_tick % fehlgeschlagen: %', r.tenant_id, sqlerrm;
    end;
  end loop;
  return n;
end $$;

-- Cron umstellen: fest-verdrahteten e-One-Job durch generischen ersetzen.
select cron.unschedule('backfill-eone');
select cron.schedule('backfill-alle', '*/2 * * * *', 'select internal.cron_backfill_alle()');;

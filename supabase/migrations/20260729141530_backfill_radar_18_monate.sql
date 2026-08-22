-- Erweitert backfill_starten um die zwei Report-Typen des Erstattungs-Radars
-- (DataDoe #1): Inventar-Ledger-Adjustments und Reimbursements über 18 Monate,
-- weil Amazon FBA-Erstattungsansprüche bis ~18 Monate rückwirkend zulässt.
-- Die vorhandenen Blöcke (Orders/Returns/Sales) bleiben unverändert; alle Inserts
-- sind per NOT EXISTS idempotent, ein erneuter Aufruf dupliziert nichts.
create or replace function public.backfill_starten(p_tenant uuid, p_monate integer default 24)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  -- Erstattungs-Radar: Inventar-Ledger-Adjustments (60-Tage-Chunks) über 18 Monate.
  with fenster as (select gs as k from generate_series(0, ceil(540/60.0)::int - 1) gs),
       ins as (
         insert into public.backfill_jobs (tenant_id, report_type, von, bis, status)
         select p_tenant, 'GET_LEDGER_DETAIL_VIEW_DATA',
                (current_date - ((f.k+1)*60))::date, (current_date - (f.k*60))::date, 'pending'
         from fenster f
         where not exists (select 1 from public.backfill_jobs b
           where b.tenant_id=p_tenant and b.report_type='GET_LEDGER_DETAIL_VIEW_DATA'
             and b.von=(current_date-((f.k+1)*60))::date and b.bis=(current_date-(f.k*60))::date)
         returning 1)
  select count(*) into v_add from ins;
  v_ins := v_ins + v_add;

  -- Erstattungs-Radar: Reimbursements (180-Tage-Chunks) über 18 Monate.
  with fenster as (select gs as k from generate_series(0, ceil(540/180.0)::int - 1) gs),
       ins as (
         insert into public.backfill_jobs (tenant_id, report_type, von, bis, status)
         select p_tenant, 'GET_FBA_REIMBURSEMENTS_DATA',
                (current_date - ((f.k+1)*180))::date, (current_date - (f.k*180))::date, 'pending'
         from fenster f
         where not exists (select 1 from public.backfill_jobs b
           where b.tenant_id=p_tenant and b.report_type='GET_FBA_REIMBURSEMENTS_DATA'
             and b.von=(current_date-((f.k+1)*180))::date and b.bis=(current_date-(f.k*180))::date)
         returning 1)
  select count(*) into v_add from ins;
  v_ins := v_ins + v_add;

  return v_ins;
end $function$;;

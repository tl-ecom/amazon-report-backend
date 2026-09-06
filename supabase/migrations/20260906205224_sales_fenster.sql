-- Sales & Traffic ueber einen frei waehlbaren Zeitraum (30/60/90 Tage oder
-- Kalender) — als eigener, abgelegter Report je Fenster.
--
-- Warum ein Report je Fenster und keine Tagesreihe je ASIN: Der Sales-&-
-- Traffic-Report liefert Sessions je ASIN nur als Summe ueber das angefragte
-- Fenster (salesAndTrafficByAsin hat kein Datum). Eine ASIN-Tagesreihe
-- braeuchte einen Report je Tag. Ein Fenster-Report ist EINE Anfrage bei
-- Amazon (bis 90 Tage erlaubt) und danach sofort da.
--
-- Solche Fenster-Reports liegen in report_data mit is_latest=false und der
-- Spalte fenster ({von, bis, schluessel}). Der aktuelle Stand (is_latest) bleibt
-- unberuehrt — sonst zeigte die Uebersicht nach einem 90-Tage-Abruf ploetzlich
-- 90 Tage als „aktuell".

alter table public.report_data add column if not exists fenster jsonb;
create index if not exists report_data_fenster_idx
  on public.report_data (tenant_id, report_type, (fenster->>'schluessel'))
  where fenster is not null;
comment on column public.report_data.fenster is
  'Nur bei Fenster-Reports (Sales & Traffic ueber einen gewaehlten Zeitraum): {von, bis, schluessel}. NULL beim regulaeren Tagesstand.';

-- Fenster-Report anstossen. Public-RPC, weil die API-Function ueber PostgREST
-- nur public erreicht; nur service_role darf sie rufen.
create or replace function public.sales_fenster_anstossen(p_tenant uuid, p_von date, p_bis date)
returns bigint
language plpgsql security definer set search_path to 'public', 'internal', 'net'
as $function$
declare
  v_tage int := (p_bis - p_von);
begin
  if p_von is null or p_bis is null or p_bis < p_von then
    raise exception 'von/bis ungueltig: % bis %', p_von, p_bis;
  end if;
  -- Amazon erlaubt fuer Sales & Traffic hoechstens 90 Tage je Anfrage.
  if v_tage > 89 then
    raise exception 'Zeitraum umfasst % Tage, erlaubt sind hoechstens 90.', v_tage + 1;
  end if;
  if not exists (
    select 1 from public.auth_contexts where tenant_id = p_tenant and source = 'sp' and status = 'connected'
  ) then
    raise exception 'Tenant % ist nicht SP-verbunden', p_tenant;
  end if;

  return internal.stosse_sync_an(p_tenant, jsonb_build_object(
    'report_type', 'GET_SALES_AND_TRAFFIC_REPORT',
    -- sync-report rechnet start = end - days; das Fenster von..bis inklusive
    -- entspricht also days = bis - von.
    'days', v_tage,
    'end_date', p_bis::text,
    'fenster', jsonb_build_object('von', p_von::text, 'bis', p_bis::text,
                                  'schluessel', p_von::text || '_' || p_bis::text)
  ));
end $function$;
revoke all on function public.sales_fenster_anstossen(uuid, date, date) from public, anon, authenticated;
grant execute on function public.sales_fenster_anstossen(uuid, date, date) to service_role;

notify pgrst, 'reload schema';

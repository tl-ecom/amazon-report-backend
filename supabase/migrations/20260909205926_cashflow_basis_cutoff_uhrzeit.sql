-- Der Settlement-Bericht nennt den Periodenschnitt auf die Sekunde genau, nicht
-- nur auf den Tag. Bei Vaneja steht dort ueber Monate hinweg 15:44:21–25 UTC —
-- der Schnitt ist also kontostabil und liegt bei 17:44 Uhr deutscher Zeit. Das
-- ist die Antwort auf "14 Tage, aber wann genau?", und sie stand die ganze Zeit
-- in den Rohdaten. Die Spalten settlement_start/end sind nur date und haben sie
-- weggeschnitten.
--
-- Das Format kommt marktplatzabhaengig ("DD.MM.YYYY HH:MM:SS UTC" fuer DE).
-- Passt es nicht, kommt NULL heraus statt eines geratenen Zeitpunkts.
create or replace function public.cashflow_zeitpunkte(p_tenant uuid, p_tage integer default 120)
returns table(settlement_id text, bis_utc timestamptz, auszahlung_utc timestamptz)
language sql stable security definer set search_path to 'public'
as $function$
  with roh as (
    select distinct s.settlement_id,
           s.raw->>'settlement-end-date' as ende_roh,
           s.raw->>'deposit-date' as auszahlung_roh
    from public.settlement_zeilen s
    where s.tenant_id = p_tenant
      and s.settlement_start is not null
      and s.auszahlung_datum >= (current_date - p_tage)
  )
  select r.settlement_id,
         case when r.ende_roh ~ '^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} UTC$'
              then to_timestamp(replace(r.ende_roh,' UTC',''), 'DD.MM.YYYY HH24:MI:SS') at time zone 'UTC'
         end,
         case when r.auszahlung_roh ~ '^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} UTC$'
              then to_timestamp(replace(r.auszahlung_roh,' UTC',''), 'DD.MM.YYYY HH24:MI:SS') at time zone 'UTC'
         end
  from roh r;
$function$;

revoke all on function public.cashflow_zeitpunkte(uuid, integer) from public, anon, authenticated;
grant execute on function public.cashflow_zeitpunkte(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

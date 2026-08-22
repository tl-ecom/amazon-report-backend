-- Orders-basierte Tagesumsätze (tagesaktuell, näher an Sellerboard als der
-- verzögerte Sales-&-Traffic-Report). Tag-Grenze in Europe/Berlin (amazon.de),
-- Stornos ausgeschlossen. item_price_cents ist der Zeilen-Gesamtpreis = Umsatz.
-- Fehlende Preise (z. B. in Zustellung) werden mitgezählt (zeilen_ohne_preis),
-- damit der Umsatz ehrlich als Untergrenze erkennbar bleibt.
create or replace function public.orders_umsatz_taeglich(p_tenant uuid, p_von date, p_bis date)
returns table(
  datum date,
  umsatz_cents bigint,
  einheiten bigint,
  zeilen bigint,
  zeilen_ohne_preis bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select (o.purchase_date at time zone 'Europe/Berlin')::date as datum,
         coalesce(sum(o.item_price_cents), 0)::bigint as umsatz_cents,
         coalesce(sum(o.quantity), 0)::bigint as einheiten,
         count(*)::bigint as zeilen,
         count(*) filter (where o.item_price_cents is null)::bigint as zeilen_ohne_preis
  from public.orders_history o
  where o.tenant_id = p_tenant
    and (o.purchase_date at time zone 'Europe/Berlin')::date between p_von and p_bis
    and coalesce(o.order_status, '') <> 'Cancelled'
  group by (o.purchase_date at time zone 'Europe/Berlin')::date
  order by datum;
$function$;

revoke all on function public.orders_umsatz_taeglich(uuid, date, date) from public, anon, authenticated;
grant execute on function public.orders_umsatz_taeglich(uuid, date, date) to service_role;;

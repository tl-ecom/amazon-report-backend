-- Umsatz EINER ASIN in einem Fenster (für die Effekt-Messung im Wiedervorlage-Loop).
-- Tag-Grenze Europe/Berlin wie bei orders_umsatz_taeglich, Stornos ausgeschlossen.
-- tage = Tage MIT Verkauf im Fenster (fürs ehrliche Normalisieren auf 30 Tage).
create or replace function public.asin_umsatz_fenster(p_tenant uuid, p_asin text, p_von date, p_bis date)
returns table(umsatz_cents bigint, einheiten bigint, tage_mit_verkauf integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(sum(o.item_price_cents), 0)::bigint,
         coalesce(sum(o.quantity), 0)::bigint,
         count(distinct (o.purchase_date at time zone 'Europe/Berlin')::date)::int
  from public.orders_history o
  where o.tenant_id = p_tenant
    and o.asin = p_asin
    and (o.purchase_date at time zone 'Europe/Berlin')::date between p_von and p_bis
    and coalesce(o.order_status, '') <> 'Cancelled';
$function$;

revoke all on function public.asin_umsatz_fenster(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.asin_umsatz_fenster(uuid, text, date, date) to service_role;;

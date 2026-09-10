-- Pulse-Zahlen je Monat in der Form, in der Sellerboard sie ausweist.
--
-- Grundlage der Gegenprobe. Alles nach BESTELLDATUM, weil Sellerboard so
-- rechnet: eine Gebuehr gehoert zu dem Monat, in dem verkauft wurde, nicht zu
-- dem, in dem Amazon sie gebucht hat. Genau dieser Unterschied hat schon
-- einmal eine Fehlmessung erzeugt (Werbung 13.485 € statt 11.586 €, weil nach
-- Buchungsdatum gefiltert wurde).
--
-- `abdeckung` kommt mit, weil ein Monat ohne vollstaendige Abrechnung
-- zwangslaeufig abweicht — das ist dann kein Fehler, sondern Verzug, und die
-- Auswertung muss beides unterscheiden koennen.
create or replace function public.pulse_monatszahlen(
  p_tenant uuid,
  p_monate integer default 6
)
returns table(
  monat text,
  umsatz_cents bigint,
  einheiten bigint,
  werbung_cents bigint,
  gebuehren_cents bigint,
  ust_cents bigint,
  abdeckung numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with monate as (
    select to_char(g, 'YYYY-MM') as monat,
           g::date as von,
           (g + interval '1 month' - interval '1 day')::date as bis
    from generate_series(
      date_trunc('month', current_date) - make_interval(months => p_monate),
      date_trunc('month', current_date),
      interval '1 month'
    ) g
  )
  select m.monat,
         coalesce((
           select sum(o.item_price_cents)::bigint from public.orders_history o
           where o.tenant_id = p_tenant
             and o.purchase_date >= m.von and o.purchase_date < m.bis + 1
             and coalesce(o.order_status,'') not ilike '%cancel%'
         ), 0),
         coalesce((
           select sum(o.quantity)::bigint from public.orders_history o
           where o.tenant_id = p_tenant
             and o.purchase_date >= m.von and o.purchase_date < m.bis + 1
             and coalesce(o.order_status,'') not ilike '%cancel%'
         ), 0),
         -- Werbung nach Werbedatum, nicht nach Abbuchung.
         coalesce((select sum(a.spend_cents)::bigint
                   from public.ads_summen(p_tenant, m.von, m.bis) a
                   where a.ebene = 'gesamt'), 0),
         coalesce((select sum(p.gebuehren_cents)::bigint
                   from public.produkt_uebersicht(p_tenant, m.von, m.bis) p), 0),
         -- Vereinnahmte Umsatzsteuer, ebenfalls nach Bestelldatum.
         coalesce((
           select sum(s.betrag_cents)::bigint
           from public.settlement_zeilen s
           join public.orders_history o
             on o.tenant_id = p_tenant and o.amazon_order_id = s.order_id
           where s.tenant_id = p_tenant
             and s.betrag_beschreibung in ('Tax','ShippingTax','GiftWrapTax','TaxDiscount')
             and o.purchase_date >= m.von and o.purchase_date < m.bis + 1
         ), 0),
         coalesce((select round(avg(p.gebuehren_abdeckung)::numeric, 3)
                   from public.produkt_uebersicht(p_tenant, m.von, m.bis) p
                   where p.gebuehren_abdeckung is not null), 0)
  from monate m
  order by m.monat desc;
$function$;

revoke all on function public.pulse_monatszahlen(uuid, integer) from public, anon, authenticated;
grant execute on function public.pulse_monatszahlen(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

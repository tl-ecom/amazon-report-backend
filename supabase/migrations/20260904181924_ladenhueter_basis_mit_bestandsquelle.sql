-- Ladenhueter zieht mit Nachschub gleich: Bestand ueber public.bestand_je_asin,
-- also aus der frischeren der beiden Quellen, plus Stand und Quelle in der
-- Ausgabe.
--
-- Bei Langsamdrehern sind zwei Tage Versatz weniger dramatisch als beim
-- Nachschub — aber ein Ladenhueter-Befund fuehrt zu Entscheidungen ueber
-- Abverkauf und Entfernung, und die trifft man nicht gern auf einem Stand, von
-- dem man nicht weiss, wie alt er ist.
--
-- `nachschub_unterwegs` kann jetzt NULL sein (der Planungsreport kennt keine
-- Zulaufmengen). Das ist wichtiger, als es klingt: Ein Ladenhueter MIT Zulauf
-- ist ein anderer Fall als einer ohne — da kommt noch Ware, die auch liegen
-- bleibt. NULL heisst unbekannt, nicht null Stueck.
--
-- `ist_fba` und `hat_angebot` schliessen aus der Anwesenheit im Bestandsbericht
-- auf ein FBA-Angebot. Das bleibt gueltig: Der Planungsreport ist ebenfalls ein
-- FBA-Bericht, wer dort steht, lagert bei Amazon.

drop function if exists public.ladenhueter_basis(uuid);

create function public.ladenhueter_basis(p_tenant uuid)
returns table(asin text, lifetime_units bigint, lifetime_umsatz_cents bigint,
              units_0_30 bigint, umsatz_0_30_cents bigint, units_30_120 bigint,
              umsatz_30_120_cents bigint, erster_verkauf date, letzter_verkauf date,
              tage_ohne_verkauf integer, max_luecke_tage integer, neue_sku boolean,
              preis_alt_cents integer, preis_neu_cents integer, hat_angebot boolean,
              angebot_status text, bestand integer, ist_fba boolean,
              nachschub_unterwegs integer, bestand_bekannt boolean,
              bestand_stand timestamptz, bestand_quelle text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with basis as (
    select o.asin,
           sum(o.quantity)::bigint as lifetime_units,
           coalesce(sum(o.item_price_cents),0)::bigint as lifetime_umsatz_cents,
           coalesce(sum(o.quantity) filter (where o.purchase_date >= now() - interval '30 days'),0)::bigint as units_0_30,
           coalesce(sum(o.item_price_cents) filter (where o.purchase_date >= now() - interval '30 days'),0)::bigint as umsatz_0_30_cents,
           coalesce(sum(o.quantity) filter (where o.purchase_date >= now() - interval '120 days' and o.purchase_date < now() - interval '30 days'),0)::bigint as units_30_120,
           coalesce(sum(o.item_price_cents) filter (where o.purchase_date >= now() - interval '120 days' and o.purchase_date < now() - interval '30 days'),0)::bigint as umsatz_30_120_cents,
           min(o.purchase_date)::date as erster_verkauf,
           max(o.purchase_date)::date as letzter_verkauf,
           (current_date - max(o.purchase_date)::date)::int as tage_ohne_verkauf,
           round(avg(o.item_price_cents::numeric / nullif(o.quantity,0))
                 filter (where o.purchase_date >= now() - interval '120 days' and o.purchase_date < now() - interval '30 days'))::int as preis_alt_cents,
           round(avg(o.item_price_cents::numeric / nullif(o.quantity,0))
                 filter (where o.purchase_date >= now() - interval '30 days'))::int as preis_neu_cents
    from public.orders_history o
    where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
      and coalesce(o.order_status,'') <> 'Cancelled'
    group by o.asin having sum(o.quantity) > 0
  ),
  vtage as (
    select o.asin, (o.purchase_date at time zone 'Europe/Berlin')::date as d
    from public.orders_history o
    where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
      and coalesce(o.order_status,'') <> 'Cancelled'
      and (o.purchase_date at time zone 'Europe/Berlin')::date >= current_date - 120
    group by 1,2
  ),
  luecken as (select asin, greatest((d - lag(d) over (partition by asin order by d)) - 1, 0) as luecke from vtage),
  maxluecke as (select asin, coalesce(max(luecke),0)::int as max_luecke_tage from luecken group by asin),
  skuneu as (
    select b.asin, exists (
      select 1 from public.orders_history n
      where n.tenant_id = p_tenant and n.asin = b.asin and n.quantity > 0
        and coalesce(n.order_status,'') <> 'Cancelled'
        and n.purchase_date >= now() - interval '30 days'
        and n.sku is not null and n.sku not like 'amzn.gr.%'
        and not exists (select 1 from public.orders_history a
                        where a.tenant_id = p_tenant and a.asin = b.asin and a.sku = n.sku
                          and a.purchase_date < now() - interval '30 days')
    ) as neue_sku from basis b
  ),
  angebot as (
    select distinct on (s.asin) s.asin, s.status, s.is_fba
    from public.asin_snapshots s where s.tenant_id = p_tenant
    order by s.asin, s.snapshot_date desc
  ),
  lager as (
    select x.asin, x.bestand, x.unterwegs, x.stand, x.quelle
    from public.bestand_je_asin(p_tenant) x
  )
  select b.asin, b.lifetime_units, b.lifetime_umsatz_cents,
         b.units_0_30, b.umsatz_0_30_cents, b.units_30_120, b.umsatz_30_120_cents,
         b.erster_verkauf, b.letzter_verkauf, b.tage_ohne_verkauf,
         coalesce(m.max_luecke_tage,0), coalesce(s.neue_sku,false),
         b.preis_alt_cents, b.preis_neu_cents,
         (g.asin is not null or l.asin is not null) as hat_angebot,
         g.status as angebot_status,
         l.bestand,
         coalesce(g.is_fba, l.asin is not null) as ist_fba,
         l.unterwegs as nachschub_unterwegs,
         (l.asin is not null) as bestand_bekannt,
         l.stand as bestand_stand,
         l.quelle as bestand_quelle
  from basis b
  left join maxluecke m on m.asin = b.asin
  left join skuneu s on s.asin = b.asin
  left join angebot g on g.asin = b.asin
  left join lager l on l.asin = b.asin;
$function$;

revoke all on function public.ladenhueter_basis(uuid) from public, anon, authenticated;
grant execute on function public.ladenhueter_basis(uuid) to service_role;

notify pgrst, 'reload schema';;

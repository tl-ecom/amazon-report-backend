-- Erstattungen in die Ertragsrechnung aufnehmen — als EIGENE Position.
--
-- Bisher fehlten sie ganz: der Umsatz kommt aus orders_history (Bestellungen),
-- und eine Ruecksendung mindert ihn dort nicht. Bei Vaneja waren das im August
-- rund 1.600 € — Geld, das an Kunden zurueckging und im Ergebnis trotzdem als
-- Ertrag stand.
--
-- Sie werden getrennt ausgewiesen und nicht mit dem Umsatz verrechnet: eine
-- Retourenquote von 3 % ist eine Fuehrungsgroesse. Im Nettoumsatz versteckt
-- sieht man sie nie wieder.
--
-- Aufgenommen werden nur die UMSATZSEITIGEN Refund-Zeilen:
--   ItemPrice/Principal, ItemPrice/Shipping, Promotion/Shipping
-- Bewusst NICHT die Steuerzeilen (die Rechnung ist netto) und NICHT die
-- ItemFees-Zeilen (RefundCommission, zurueckerstattete Provision) — die
-- stecken bereits in gebuehren_cents, weil produkt_gebuehren alle
-- Abrechnungszeilen einer Bestellung nimmt. Sie hier erneut zu zaehlen waere
-- eine Doppelerfassung an genau der Stelle, an der niemand nachrechnet.
--
-- Nicht enthalten ist der Warenwert zurueckgekommener Ware (Sellerboard:
-- "Value of returned items", im August +116 €). Ob ein Ruecklaeufer wieder
-- verkaeuflich ist, steht in diesen Daten nicht — und ihn pauschal
-- gutzuschreiben waere geraten.
drop function if exists public.ertrag_abgerechnet(uuid, numeric);

create function public.ertrag_abgerechnet(
  p_tenant uuid,
  p_min_abdeckung numeric default 0.8
)
returns table(
  monat text,
  von date,
  bis date,
  umsatz_netto_cents bigint,
  wareneinsatz_cents bigint,
  gebuehren_cents bigint,
  werbung_cents bigint,
  erstattungen_cents bigint,
  ertrag_cents bigint,
  abdeckung numeric,
  monate_geprueft integer
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
      date_trunc('month', current_date) - interval '6 months',
      date_trunc('month', current_date),
      interval '1 month'
    ) g
    where g < date_trunc('month', current_date)
  ),
  werte as (
    select m.monat, m.von, m.bis,
           coalesce(sum(pu.umsatz_cents),0)::bigint as umsatz,
           coalesce(sum(pu.wareneinsatz_cents),0)::bigint as ek,
           coalesce(sum(pu.gebuehren_cents),0)::bigint as geb,
           coalesce(round((sum(pu.umsatz_cents * pu.gebuehren_abdeckung)
                           / nullif(sum(pu.umsatz_cents),0))::numeric, 3), 0) as abd
    from monate m
    left join lateral public.produkt_uebersicht(p_tenant, m.von, m.bis) pu on true
    group by m.monat, m.von, m.bis
  ),
  gewaehlt as (
    select * from werte
    where abd >= p_min_abdeckung and umsatz > 0
    order by monat desc
    limit 1
  ),
  -- Nach BESTELLDATUM zugeordnet, wie der Rest der Rechnung: der Ertrag einer
  -- Bestellung gehoert in den Monat, in dem verkauft wurde. Sellerboard bucht
  -- Erstattungen auf das Erstattungsdatum — daher weichen die Monatswerte
  -- leicht voneinander ab.
  erstattung as (
    select coalesce(sum(s.betrag_cents),0)::bigint as betrag
    from gewaehlt g
    join public.settlement_zeilen s on s.tenant_id = p_tenant
    join public.orders_history o
      on o.tenant_id = p_tenant and o.amazon_order_id = s.order_id
    where s.transaktionstyp = 'Refund'
      and (
        (s.betrag_typ = 'ItemPrice' and s.betrag_beschreibung in ('Principal','Shipping'))
        or (s.betrag_typ = 'Promotion' and s.betrag_beschreibung = 'Shipping')
      )
      and o.purchase_date >= g.von and o.purchase_date < g.bis + 1
  ),
  werbung as (
    select coalesce(sum(a.spend_cents),0)::bigint as betrag
    from gewaehlt g
    join lateral public.ads_summen(p_tenant, g.von, g.bis) a on true
    where a.ebene = 'gesamt'
  )
  select g.monat, g.von, g.bis,
         g.umsatz, g.ek, g.geb, w.betrag, e.betrag,
         -- Gebuehren und Erstattungen kommen negativ, Werbung positiv.
         (g.umsatz - g.ek + g.geb - w.betrag + e.betrag)::bigint,
         g.abd,
         (select count(*)::int from werte)
  from gewaehlt g, werbung w, erstattung e;
$function$;

revoke all on function public.ertrag_abgerechnet(uuid, numeric) from public, anon, authenticated;
grant execute on function public.ertrag_abgerechnet(uuid, numeric) to service_role;

notify pgrst, 'reload schema';;

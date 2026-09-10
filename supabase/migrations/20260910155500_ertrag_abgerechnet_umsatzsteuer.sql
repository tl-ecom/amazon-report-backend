-- Die Umsatzsteuer fehlte in der Ertragsrechnung.
--
-- Aufgefallen erst beim Abgleich gegen Sellerboards GuV: fuer Juli wies Pulse
-- 10.486 € aus, Sellerboard 2.749 €. Der Grund ist eine falsche Annahme ueber
-- eine Spalte — produkt_uebersicht.umsatz_cents ist BRUTTO, identisch mit
-- orders_history.item_price_cents. Ich hatte sie als Nettoumsatz gelesen und
-- die Steuer nie abgezogen: 8.821 € zu viel im Ergebnis.
--
-- Die Spalte heisst jetzt umsatz_brutto_cents statt umsatz_netto_cents, damit
-- derselbe Irrtum nicht noch einmal passiert. Ein Name, der das Gegenteil von
-- dem sagt, was drinsteht, ist schlimmer als gar keiner.
--
-- Die Steuer wird als EIGENE Position gefuehrt, nicht vom Umsatz abgezogen:
-- sie ist ein durchlaufender Posten und keine Kosten, und wer sie sehen will,
-- soll sie sehen. Das entspricht Sellerboards Aufstellung.
drop function if exists public.ertrag_abgerechnet(uuid, numeric);

create function public.ertrag_abgerechnet(
  p_tenant uuid,
  p_min_abdeckung numeric default 0.8
)
returns table(
  monat text,
  von date,
  bis date,
  umsatz_brutto_cents bigint,
  umsatzsteuer_cents bigint,
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
  -- Vereinnahmte Umsatzsteuer, nach BESTELLDATUM wie der Rest der Rechnung.
  steuer as (
    select coalesce(sum(s.betrag_cents),0)::bigint as betrag
    from gewaehlt g
    join public.settlement_zeilen s on s.tenant_id = p_tenant
    join public.orders_history o
      on o.tenant_id = p_tenant and o.amazon_order_id = s.order_id
    where s.betrag_beschreibung in ('Tax','ShippingTax','GiftWrapTax','TaxDiscount')
      and o.purchase_date >= g.von and o.purchase_date < g.bis + 1
  ),
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
         g.umsatz, st.betrag, g.ek, g.geb, w.betrag, e.betrag,
         -- Steuer kommt positiv herein (vereinnahmt) und geht ab; Gebuehren und
         -- Erstattungen kommen negativ; Werbung positiv.
         (g.umsatz - st.betrag - g.ek + g.geb - w.betrag + e.betrag)::bigint,
         g.abd,
         (select count(*)::int from werte)
  from gewaehlt g, werbung w, erstattung e, steuer st;
$function$;

revoke all on function public.ertrag_abgerechnet(uuid, numeric) from public, anon, authenticated;
grant execute on function public.ertrag_abgerechnet(uuid, numeric) to service_role;

notify pgrst, 'reload schema';;

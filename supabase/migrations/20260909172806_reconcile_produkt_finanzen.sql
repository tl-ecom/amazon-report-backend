-- Abstimmung einer ASIN gegen die Rohdaten. Fuer den Fall, dass Pulse und eine
-- externe Auswertung (Sellerboard, Amazons eigene Zahlen) auseinanderlaufen.
--
-- Zeigt beide Periodenbegriffe nebeneinander:
--   nach_bestelldatum  — was zu den Bestellungen DIESES Fensters gehoert (so
--                        rechnet Pulse, und so gehoert es zum Umsatz)
--   nach_buchungsdatum — was Amazon in diesem Fenster GEBUCHT hat (so rechnete
--                        Pulse frueher, und daher kam die Abweichung)
--
-- Der Unterschied zwischen beiden IST die Erklaerung, wenn jemand fragt, warum
-- die Gebuehren nicht stimmen. Genau daran ist der Fehler vom 09.09. sichtbar
-- geworden: 68 Einheiten nach Bestelldatum gegen 118 nach Buchungsdatum.
--
-- Meldet ausserdem Dubletten: gleiche Bestellung, gleiche Gebuehrenart, gleicher
-- Betrag, mehrfach vorhanden. War bei der Untersuchung null — soll es bleiben.

create or replace function public.reconcile_produkt_finanzen(
  p_tenant uuid, p_asin text, p_von date, p_bis date
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with skus as (
    select distinct o.sku from public.orders_history o
    where o.tenant_id = p_tenant and o.asin = p_asin and o.sku is not null
  ),
  best as (
    select o.amazon_order_id, o.sku, o.quantity, o.item_price_cents
    from public.orders_history o
    where o.tenant_id = p_tenant and o.asin = p_asin
      and coalesce(o.order_status,'') <> 'Cancelled'
      and o.purchase_date::date between p_von and p_bis
  ),
  fees_bestell as (
    select s.betrag_beschreibung, s.betrag_cents, s.order_id, s.sku
    from best b
    join public.settlement_zeilen s
      on s.tenant_id = p_tenant and s.order_id = b.amazon_order_id and s.sku = b.sku
    where s.betrag_typ = 'ItemFees'
  ),
  fees_buchung as (
    select s.betrag_beschreibung, s.betrag_cents
    from public.settlement_zeilen s
    where s.tenant_id = p_tenant and s.sku in (select sku from skus)
      and s.betrag_typ = 'ItemFees'
      and s.gebucht_am between p_von and p_bis
  ),
  dubletten as (
    select count(*)::bigint as gruppen, coalesce(sum(n - 1), 0)::bigint as ueberzaehlig
    from (
      select count(*) as n
      from fees_bestell
      group by order_id, sku, betrag_beschreibung, betrag_cents
      having count(*) > 1
    ) x
  ),
  ek as (
    select e.ek_cents from public.asin_ek e
    where e.tenant_id = p_tenant and e.asin = p_asin and e.gueltig_ab <= p_bis
    order by e.gueltig_ab desc limit 1
  ),
  g as (select * from public.produkt_gebuehren(p_tenant, p_von, p_bis) where asin = p_asin)
  select jsonb_build_object(
    'asin', p_asin,
    'zeitraum', jsonb_build_object('von', p_von, 'bis', p_bis),
    'hinweis', 'Alle Betraege in Cent, BRUTTO wie von Amazon gebucht (DE inkl. USt.). '
               || 'Gutschriften sind nicht USt.-behaftet.',
    'umsatz', jsonb_build_object(
      'brutto_cents', (select coalesce(sum(item_price_cents),0) from best),
      'einheiten', (select coalesce(sum(quantity),0) from best),
      'bestellzeilen', (select count(*) from best)),
    'nach_bestelldatum', jsonb_build_object(
      'verkaufsgebuehr_cents', (select coalesce(sum(betrag_cents),0) from fees_bestell where betrag_beschreibung in ('Commission','RefundCommission')),
      'fba_cents', (select coalesce(sum(betrag_cents),0) from fees_bestell where betrag_beschreibung = 'FBAPerUnitFulfillmentFee'),
      'sonstige_cents', (select coalesce(sum(betrag_cents),0) from fees_bestell where betrag_beschreibung not in ('Commission','RefundCommission','FBAPerUnitFulfillmentFee')),
      'zeilen', (select count(*) from fees_bestell)),
    'nach_buchungsdatum', jsonb_build_object(
      'verkaufsgebuehr_cents', (select coalesce(sum(betrag_cents),0) from fees_buchung where betrag_beschreibung in ('Commission','RefundCommission')),
      'fba_cents', (select coalesce(sum(betrag_cents),0) from fees_buchung where betrag_beschreibung = 'FBAPerUnitFulfillmentFee'),
      'sonstige_cents', (select coalesce(sum(betrag_cents),0) from fees_buchung where betrag_beschreibung not in ('Commission','RefundCommission','FBAPerUnitFulfillmentFee')),
      'zeilen', (select count(*) from fees_buchung)),
    'ergebnis_pulse', (select to_jsonb(g) from g),
    'dubletten', (select to_jsonb(d) from dubletten d),
    'ek', jsonb_build_object(
      'je_stueck_cents', (select ek_cents from ek),
      'basis_einheiten', (select coalesce(sum(quantity),0) from best),
      'summe_cents', (select coalesce(sum(quantity),0) from best) * coalesce((select ek_cents from ek), 0),
      'hinweis', 'Basis sind die im Fenster BESTELLTEN Einheiten. Externe Werkzeuge '
                 || 'rechnen teils mit versandten oder abgerechneten Einheiten — dann '
                 || 'weicht die Summe ab, ohne dass ein Stueckpreis falsch waere.')
  );
$function$;

revoke all on function public.reconcile_produkt_finanzen(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.reconcile_produkt_finanzen(uuid, text, date, date) to service_role;

notify pgrst, 'reload schema';;

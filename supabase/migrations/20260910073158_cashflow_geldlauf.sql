-- Wie lange dauert es vom Verkauf bis zum Geld auf dem Konto?
--
-- Anlass: Amazon gibt Guthaben bei vielen Konten erst sieben Tage nach der
-- ZUSTELLUNG frei ("DD+7"), nicht nach der Bestellung. Das verlaengert den
-- Geldlauf weit ueber die Abrechnungsperiode hinaus, und es ist im
-- Kontoauszug nirgends als Posten sichtbar — es aeussert sich nur darin, dass
-- Umsaetze in eine spaetere Abrechnung fallen.
--
-- An Vanejas Daten gemessen (5.400 Bestellungen): Median 18 Tage von der
-- Bestellung bis zur Auszahlung, frueheste Eingaenge nach 11 Tagen. Ohne
-- Sperre muesste eine Bestellung kurz vor Periodenende nach zwei bis drei
-- Tagen ausgezahlt sein — solche Faelle gibt es nicht. Das ist der Nachweis.
--
-- Diese Funktion misst nur. Die Ableitung (Prognose der Zufluesse) liegt in
-- cashflow_geldlauf.ts, damit sie getestet werden kann.
create or replace function public.cashflow_geldlauf(
  p_tenant uuid,
  p_tage integer default 120
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with grenze as (select (current_date - p_tage)::date as ab),
  -- Kopfzeilen tragen das Auszahlungsdatum, Transaktionszeilen die order_id.
  kopf as (
    select s.settlement_id, s.auszahlung_datum, max(s.gesamtbetrag_cents) as betrag_cents
    from public.settlement_zeilen s cross join grenze g
    where s.tenant_id = p_tenant
      and s.settlement_start is not null
      and s.auszahlung_datum between g.ab and current_date
    group by 1, 2
  ),
  bestellzeile as (
    select distinct s.settlement_id, s.order_id
    from public.settlement_zeilen s cross join grenze g
    where s.tenant_id = p_tenant
      and s.order_id is not null
      and s.betrag_beschreibung = 'Principal'
      and s.gebucht_am >= g.ab
  ),
  -- Der eigentliche Messwert: Tage von der Bestellung bis zur Auszahlung.
  lauf as (
    select (k.auszahlung_datum - o.purchase_date::date) as tage,
           o.item_price_cents
    from bestellzeile b
    join kopf k on k.settlement_id = b.settlement_id
    join public.orders_history o
      on o.tenant_id = p_tenant and o.amazon_order_id = b.order_id
    where k.auszahlung_datum >= o.purchase_date::date
  ),
  verteilung as (
    select jsonb_agg(jsonb_build_object('tage', x.tage, 'bestellungen', x.anzahl)
                     order by x.tage) as j
    from (
      select tage, count(*)::bigint as anzahl
      from lauf
      -- Ausreisser abschneiden: Sonderabrechnungen ueber Monate hinweg wuerden
      -- die Verteilung verzerren, ohne den Regelfall zu beschreiben.
      where tage between 0 and 60
      group by tage
      having count(*) >= 5
    ) x
  ),
  -- Anteil des Bruttoumsatzes, der als Auszahlung ankommt. Der Rest sind
  -- Gebuehren, Werbung und Steuer. Bewusst gemessen statt gerechnet: die
  -- Abzuege sind je Konto verschieden und aendern sich.
  quote as (
    select (select sum(k.betrag_cents) from kopf k where k.betrag_cents > 0)::numeric
           / nullif((
               select sum(o.item_price_cents)
               from public.orders_history o cross join grenze g
               where o.tenant_id = p_tenant
                 and o.purchase_date >= g.ab + 20
                 and o.purchase_date < current_date - 20
                 and coalesce(o.order_status,'') not ilike '%cancel%'
             ), 0) as q
  ),
  -- Noch nicht abgerechnete Bestellungen: aus ihnen kommt das Geld, das der
  -- Kalender vorhersagt.
  abgerechnet as (
    select distinct s.order_id from public.settlement_zeilen s
    where s.tenant_id = p_tenant and s.order_id is not null
  ),
  offen as (
    select jsonb_agg(jsonb_build_object('am', x.tag, 'brutto_cents', x.brutto)
                     order by x.tag) as j
    from (
      select o.purchase_date::date as tag, sum(o.item_price_cents)::bigint as brutto
      from public.orders_history o
      left join abgerechnet a on a.order_id = o.amazon_order_id
      where o.tenant_id = p_tenant
        and a.order_id is null
        and o.purchase_date >= current_date - 45
        and coalesce(o.order_status,'') not ilike '%cancel%'
      group by 1
    ) x
  )
  select jsonb_build_object(
    'stand', current_date,
    'fenster_tage', p_tage,
    'verteilung', coalesce((select j from verteilung), '[]'::jsonb),
    'auszahlungsquote', (select round(q, 4) from quote),
    'offen', coalesce((select j from offen), '[]'::jsonb)
  );
$function$;

revoke all on function public.cashflow_geldlauf(uuid, integer) from public, anon, authenticated;
grant execute on function public.cashflow_geldlauf(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

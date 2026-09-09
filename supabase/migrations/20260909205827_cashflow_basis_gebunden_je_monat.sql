-- Korrektur an cashflow_basis: "gebundenes Geld" war zu gross gerechnet.
--
-- Gemessen an Vaneja: April 2026 ist zu 90 % ohne Abrechnungszeile, Mai bis
-- Juli zu unter 1 %. Der April ist keine offene Forderung, sondern der Rand
-- der Settlement-Historie — so weit zurueck wurden die Berichte nie geholt.
-- Die alte Fassung haette daraus 38.978 € "unterwegs" gemacht und damit eine
-- Datenluecke als Guthaben ausgewiesen.
--
-- Neu: die Abdeckung kommt JE MONAT heraus. Ein Monat mit 0,2 % offen ist
-- abgerechnet, einer mit 90 % ist unbekannt — und diese beiden Faelle darf
-- niemand addieren. Die Unterscheidung trifft cashflow.ts, weil sie dort
-- getestet werden kann.
create or replace function public.cashflow_basis(
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
  auszahlungen as (
    select jsonb_agg(jsonb_build_object(
             'settlement_id', s.settlement_id,
             'von', s.settlement_start,
             'bis', s.settlement_end,
             'auszahlung_am', s.auszahlung_datum,
             'betrag_cents', s.gesamtbetrag_cents
           ) order by s.settlement_end desc) as j
    from public.settlement_zeilen s cross join grenze g
    where s.tenant_id = p_tenant
      and s.settlement_start is not null
      and s.auszahlung_datum >= g.ab
  ),
  reserve as (
    select jsonb_agg(jsonb_build_object(
             'gebucht_am', x.gebucht_am, 'art', x.betrag_beschreibung,
             'betrag_cents', x.betrag_cents
           ) order by x.gebucht_am desc) as j
    from (
      select s.gebucht_am, s.betrag_beschreibung, sum(s.betrag_cents)::bigint as betrag_cents
      from public.settlement_zeilen s cross join grenze g
      where s.tenant_id = p_tenant
        and s.betrag_typ = 'other-transaction'
        and s.betrag_beschreibung in ('Current Reserve Amount','Previous Reserve Amount Balance')
        and s.gebucht_am >= g.ab
      group by 1,2
    ) x
  ),
  termine as (
    select jsonb_agg(jsonb_build_object(
             'art', x.betrag_typ, 'gebucht_am', x.gebucht_am, 'betrag_cents', x.betrag_cents
           ) order by x.gebucht_am desc) as j
    from (
      select s.betrag_typ, s.gebucht_am, sum(s.betrag_cents)::bigint as betrag_cents
      from public.settlement_zeilen s cross join grenze g
      where s.tenant_id = p_tenant
        and s.gebucht_am >= g.ab
        and (s.betrag_typ in ('FBA Inventory Storage Fee','FBA Long Term Storage Fee')
             or (s.betrag_typ = 'other-transaction' and s.betrag_beschreibung = 'Subscription Fee'))
      group by 1,2
    ) x
  ),
  werbung as (
    select jsonb_agg(jsonb_build_object(
             'gebucht_am', x.gebucht_am, 'betrag_cents', x.betrag_cents
           ) order by x.gebucht_am desc) as j
    from (
      select s.gebucht_am, sum(s.betrag_cents)::bigint as betrag_cents
      from public.settlement_zeilen s cross join grenze g
      where s.tenant_id = p_tenant
        and s.betrag_typ = 'Cost of Advertising' and s.gebucht_am >= g.ab
      group by 1
    ) x
  ),
  vorsteuer as (
    select jsonb_agg(jsonb_build_object(
             'monat', x.monat, 'ausgewiesen_cents', x.ausgewiesen,
             'in_gebuehren_cents', x.eingerechnet
           ) order by x.monat desc) as j
    from (
      select to_char(s.gebucht_am,'YYYY-MM') as monat,
             sum(s.betrag_cents) filter (where s.betrag_beschreibung = 'Tax on fee')::bigint as ausgewiesen,
             sum(s.betrag_cents) filter (where s.betrag_typ = 'ItemFees')::bigint as eingerechnet
      from public.settlement_zeilen s cross join grenze g
      where s.tenant_id = p_tenant and s.gebucht_am >= g.ab
        and (s.betrag_beschreibung = 'Tax on fee' or s.betrag_typ = 'ItemFees')
      group by 1
    ) x
  ),
  abgerechnet as (
    select distinct s.order_id
    from public.settlement_zeilen s
    where s.tenant_id = p_tenant and s.order_id is not null
  ),
  je_monat as (
    select to_char(o.purchase_date,'YYYY-MM') as monat,
           count(*)::bigint as bestellungen,
           count(*) filter (where a.order_id is null)::bigint as offen_anzahl,
           coalesce(sum(o.item_price_cents) filter (where a.order_id is null),0)::bigint as offen_cents
    from public.orders_history o
    left join abgerechnet a on a.order_id = o.amazon_order_id
    cross join grenze g
    where o.tenant_id = p_tenant
      and o.purchase_date >= g.ab
      and coalesce(o.order_status,'') not ilike '%cancel%'
    group by 1
  )
  select jsonb_build_object(
    'fenster_tage', p_tage,
    'stand', current_date,
    'auszahlungen', coalesce((select j from auszahlungen), '[]'::jsonb),
    'reserve', coalesce((select j from reserve), '[]'::jsonb),
    'termin_gebuehren', coalesce((select j from termine), '[]'::jsonb),
    'werbung', coalesce((select j from werbung), '[]'::jsonb),
    'vorsteuer', coalesce((select j from vorsteuer), '[]'::jsonb),
    -- Je Monat: wie viele Bestellungen es gab und wie viele davon noch keine
    -- Abrechnungszeile haben. Erst die Reihenfolge dieser Monate verraet, ob
    -- ein offener Rest "unterwegs" ist oder das Ende der Historie.
    'abrechnung_je_monat', coalesce(
      (select jsonb_agg(jsonb_build_object(
                'monat', m.monat, 'bestellungen', m.bestellungen,
                'offen_anzahl', m.offen_anzahl, 'offen_cents', m.offen_cents
              ) order by m.monat) from je_monat m), '[]'::jsonb)
  );
$function$;

revoke all on function public.cashflow_basis(uuid, integer) from public, anon, authenticated;
grant execute on function public.cashflow_basis(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

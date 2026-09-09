-- Rohdaten fuer das Cash-Management: WANN Amazon Geld bewegt, nicht wie viel
-- Gewinn entsteht. Beides wird gern verwechselt — ein profitables Konto kann
-- trotzdem klemmen, wenn die Auszahlung 16 Tage hinter dem Wareneinkauf liegt.
--
-- Diese Funktion MISST nur und leitet nichts ab. Die Ableitung (Rhythmus,
-- naechster Termin, Prognose) liegt in cashflow.ts, weil sie dort getestet
-- werden kann. Alles hier kommt aus dem Settlement-Bericht, also aus dem, was
-- Amazon tatsaechlich gebucht hat.
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
  -- 1. Auszahlungen. Im Settlement-Bericht traegt genau EINE Zeile je
  --    settlement_id den Kopf (Zeitraum + Auszahlungsdatum + Gesamtbetrag);
  --    alle anderen Zeilen sind Transaktionen und haben dort NULL.
  auszahlungen as (
    select jsonb_agg(jsonb_build_object(
             'settlement_id', s.settlement_id,
             'von', s.settlement_start,
             'bis', s.settlement_end,
             'auszahlung_am', s.auszahlung_datum,
             'betrag_cents', s.gesamtbetrag_cents
           ) order by s.settlement_end desc) as j
    from public.settlement_zeilen s, grenze g
    where s.tenant_id = p_tenant
      and s.settlement_start is not null
      and s.auszahlung_datum >= g.ab
  ),
  -- 2. Einbehalt. "Current Reserve Amount" ist negativ = wird jetzt
  --    einbehalten; "Previous Reserve Amount Balance" ist positiv = wird aus
  --    der Vorperiode freigegeben. Der Stand ist der Betrag der juengsten
  --    Current-Zeile.
  reserve as (
    select jsonb_agg(jsonb_build_object(
             'gebucht_am', x.gebucht_am,
             'art', x.betrag_beschreibung,
             'betrag_cents', x.betrag_cents
           ) order by x.gebucht_am desc) as j
    from (
      select s.gebucht_am, s.betrag_beschreibung, sum(s.betrag_cents)::bigint as betrag_cents
      from public.settlement_zeilen s, grenze g
      where s.tenant_id = p_tenant
        and s.betrag_typ = 'other-transaction'
        and s.betrag_beschreibung in ('Current Reserve Amount','Previous Reserve Amount Balance')
        and s.gebucht_am >= g.ab
      group by 1,2
    ) x
  ),
  -- 3. Terminbuchungen: Gebuehren, die an einem festen Tag kommen statt je
  --    Bestellung. Lagergebuehr, Langzeitlagergebuehr, Kontogebuehr.
  termine as (
    select jsonb_agg(jsonb_build_object(
             'art', x.betrag_typ,
             'gebucht_am', x.gebucht_am,
             'betrag_cents', x.betrag_cents
           ) order by x.gebucht_am desc) as j
    from (
      select s.betrag_typ, s.gebucht_am, sum(s.betrag_cents)::bigint as betrag_cents
      from public.settlement_zeilen s, grenze g
      where s.tenant_id = p_tenant
        and s.gebucht_am >= g.ab
        and (s.betrag_typ in ('FBA Inventory Storage Fee','FBA Long Term Storage Fee')
             or (s.betrag_typ = 'other-transaction' and s.betrag_beschreibung = 'Subscription Fee'))
      group by 1,2
    ) x
  ),
  -- 4. Werbekosten. Amazon zieht sie NICHT zum Auszahlungstermin ab, sondern
  --    laufend. Ob nach Termin oder nach Rechnungsschwelle, entscheidet die
  --    Auswertung in cashflow.ts anhand der Abstaende und Betraege.
  werbung as (
    select jsonb_agg(jsonb_build_object(
             'gebucht_am', x.gebucht_am,
             'betrag_cents', x.betrag_cents
           ) order by x.gebucht_am desc) as j
    from (
      select s.gebucht_am, sum(s.betrag_cents)::bigint as betrag_cents
      from public.settlement_zeilen s, grenze g
      where s.tenant_id = p_tenant
        and s.betrag_typ = 'Cost of Advertising'
        and s.gebucht_am >= g.ab
      group by 1
    ) x
  ),
  -- 5. Vorsteuer in den Gebuehren, nach Monat. Zwei Quellen, die Amazon
  --    unterschiedlich ausweist:
  --      a) Kontogebuehren: eigene Zeile "Tax on fee" — direkt ablesbar.
  --      b) Bestellgebuehren (ItemFees): Steuer ist EINGERECHNET, keine eigene
  --         Zeile. Sie muss herausgerechnet werden; das kann nur die
  --         Anwendung, weil der Faktor am Steuerprofil haengt.
  --    Deshalb kommen beide Summen getrennt heraus und werden nicht vermischt.
  vorsteuer as (
    select jsonb_agg(jsonb_build_object(
             'monat', x.monat,
             'ausgewiesen_cents', x.ausgewiesen,
             'in_gebuehren_cents', x.eingerechnet
           ) order by x.monat desc) as j
    from (
      select to_char(s.gebucht_am,'YYYY-MM') as monat,
             sum(s.betrag_cents) filter (where s.betrag_beschreibung = 'Tax on fee')::bigint as ausgewiesen,
             sum(s.betrag_cents) filter (where s.betrag_typ = 'ItemFees')::bigint as eingerechnet
      from public.settlement_zeilen s, grenze g
      where s.tenant_id = p_tenant
        and s.gebucht_am >= g.ab
        and (s.betrag_beschreibung = 'Tax on fee' or s.betrag_typ = 'ItemFees')
      group by 1
    ) x
  ),
  -- 6. Gebundenes Geld: Bestellungen, zu denen noch keine Abrechnungszeile
  --    existiert. Das ist Umsatz, der Amazon schon erreicht hat, den Verkaeufer
  --    aber noch nicht — der groesste Posten im Amazon-Cash-Kreislauf und der,
  --    den niemand im Kontoauszug sieht.
  abgerechnet as (
    select distinct s.order_id
    from public.settlement_zeilen s, grenze g
    where s.tenant_id = p_tenant and s.order_id is not null and s.gebucht_am >= g.ab - 60
  ),
  offen as (
    select coalesce(sum(o.item_price_cents),0)::bigint as umsatz_cents,
           count(*)::bigint as bestellungen,
           min(o.purchase_date)::date as aelteste
    from public.orders_history o, grenze g
    where o.tenant_id = p_tenant
      and o.purchase_date >= g.ab
      and coalesce(o.order_status,'') not ilike '%cancel%'
      and not exists (select 1 from abgerechnet a where a.order_id = o.amazon_order_id)
  )
  select jsonb_build_object(
    'fenster_tage', p_tage,
    'stand', current_date,
    'auszahlungen', coalesce((select j from auszahlungen), '[]'::jsonb),
    'reserve', coalesce((select j from reserve), '[]'::jsonb),
    'termin_gebuehren', coalesce((select j from termine), '[]'::jsonb),
    'werbung', coalesce((select j from werbung), '[]'::jsonb),
    'vorsteuer', coalesce((select j from vorsteuer), '[]'::jsonb),
    'gebunden', (select to_jsonb(o) from offen o)
  );
$function$;

revoke all on function public.cashflow_basis(uuid, integer) from public, anon, authenticated;
grant execute on function public.cashflow_basis(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

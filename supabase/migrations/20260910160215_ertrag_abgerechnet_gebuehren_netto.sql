-- Gebuehren netto statt brutto in der Ertragsrechnung.
--
-- Aufgefallen beim Abgleich: fuer Juli wies Pulse 21.377 € Gebuehren aus,
-- Sellerboard 19.251 €. Nachgerechnet je Posten ist der Unterschied fast
-- exakt der Faktor 1,19:
--   FBA-Gebuehr     11.100,44 brutto -> 9.328,10 netto (Sellerboard 9.276,01)
--   Verkaufsgebuehr  9.571,09 brutto -> 8.042,93 netto (Sellerboard 8.157,22)
--
-- Amazon rechnet Gebuehren brutto ab, aber die enthaltene Vorsteuer kommt ueber
-- die Voranmeldung zurueck. Sie ist ein durchlaufender Posten und gehoert nicht
-- in die Ertragsrechnung — sonst wird derselbe Betrag zweimal belastet: einmal
-- als Gebuehr und einmal, indem er in der Steuererstattung fehlt.
--
-- Die Produktsicht macht das laengst richtig (nettoGebuehr in produkte.ts).
-- Diese RPC rechnet direkt in SQL und hatte den Schritt uebersprungen — eine
-- zweite Rechenkette fuer dieselbe Groesse, und prompt liefen sie auseinander.
--
-- OHNE Vorsteuerabzug (Kleinunternehmer) bleibt es bei brutto: dann ist die
-- Steuer tatsaechlich endgueltige Kosten.
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
  gebuehren_faktor numeric,
  monate_geprueft integer
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with profil as (
    select case
      -- Ausdruecklich gesetzter Faktor gewinnt.
      when e.gebuehren_ust_faktor is not null then e.gebuehren_ust_faktor
      -- Kein Vorsteuerabzug: die Steuer ist echte Kosten, also brutto lassen.
      when coalesce(e.vorsteuerabzug, true) = false then 1.0
      when coalesce(e.umsatzsteuerpflichtig, true) = false then 1.0
      else 1 + coalesce(e.umsatzsteuer_prozent, 19) / 100.0
    end as faktor
    from public.tenant_einstellungen e
    where e.tenant_id = p_tenant
  ),
  faktor as (
    select coalesce((select faktor from profil), 1.19) as f
  ),
  monate as (
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
           coalesce(sum(pu.gebuehren_cents),0)::bigint as geb_brutto,
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
         g.umsatz, st.betrag, g.ek,
         round(g.geb_brutto / f.f)::bigint,
         w.betrag, e.betrag,
         (g.umsatz - st.betrag - g.ek + round(g.geb_brutto / f.f) - w.betrag + e.betrag)::bigint,
         g.abd,
         f.f,
         (select count(*)::int from werte)
  from gewaehlt g, werbung w, erstattung e, steuer st, faktor f;
$function$;

revoke all on function public.ertrag_abgerechnet(uuid, numeric) from public, anon, authenticated;
grant execute on function public.ertrag_abgerechnet(uuid, numeric) to service_role;

notify pgrst, 'reload schema';;

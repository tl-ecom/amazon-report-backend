-- Rueckgabetyp aendert sich -> erst loeschen. Die Funktion wird nur vom
-- Backend aufgerufen, es haengt keine View daran.
drop function if exists public.produkt_uebersicht(uuid, date, date);

-- Die zwei grossen Gebuehrenbloecke getrennt ausweisen.
-- Sie haben voellig verschiedene Hebel: Die Verkaufsgebuehr ist ein fester
-- Prozentsatz auf den Preis, die FBA-Gebuehr haengt an Groesse und Gewicht.
-- In einer Summe sieht man nicht, welcher von beiden das Produkt drueckt.
create function public.produkt_uebersicht(p_tenant uuid, p_von date, p_bis date DEFAULT CURRENT_DATE)
returns table(
  asin text, produktname text, umsatz_cents bigint, einheiten bigint,
  wareneinsatz_cents bigint, einheiten_mit_ek bigint, retouren bigint,
  gebuehren_cents bigint, gebuehren_bekannt boolean, gebuehren_anteilig boolean,
  fba_cents bigint, verkaufsgebuehr_cents bigint, sonstige_gebuehren_cents bigint
)
language sql stable security definer set search_path to 'public'
as $function$
  with o as (
    select oh.asin,
           sum(oh.item_price_cents)::bigint as umsatz_cents,
           sum(oh.quantity)::bigint as einheiten,
           sum(coalesce(ek.ek_cents, 0) * oh.quantity)::bigint as wareneinsatz_cents,
           sum(case when ek.ek_cents is not null then oh.quantity else 0 end)::bigint as einheiten_mit_ek
    from public.orders_history oh
    left join lateral (
      select e.ek_cents from public.asin_ek e
      where e.tenant_id = oh.tenant_id and e.asin = oh.asin and e.gueltig_ab <= oh.purchase_date::date
      order by e.gueltig_ab desc limit 1
    ) ek on true
    where oh.tenant_id = p_tenant and coalesce(oh.order_status,'') <> 'Cancelled'
      and oh.purchase_date::date >= p_von and oh.purchase_date::date <= p_bis
    group by oh.asin
  ), r as (
    select rh.asin, sum(rh.return_quantity)::bigint as retouren
    from public.returns_history rh
    where rh.tenant_id = p_tenant and rh.return_request_date >= p_von and rh.return_request_date <= p_bis
    group by rh.asin
  ),
  sku_map as (
    select sku, max(asin) as asin from (
      select oh.sku, oh.asin from public.orders_history oh
      where oh.tenant_id = p_tenant and oh.sku is not null and oh.asin is not null
      union
      select f.sku, f.asin from public.fba_bestand f
      where f.tenant_id = p_tenant and f.sku is not null and f.asin is not null
    ) x group by sku
  ),
  geb as (
    select m.asin,
           sum(g.betrag_cents * m.anteil)::bigint as gebuehren_cents,
           -- Die beiden grossen Bloecke einzeln. Alles Uebrige bleibt zusammen:
           -- es ist klein und wuerde die Tabelle nur breiter machen.
           sum(case when g.fee_typ = 'FBAPerUnitFulfillmentFee'
                    then g.betrag_cents * m.anteil else 0 end)::bigint as fba_cents,
           sum(case when g.fee_typ = 'Commission'
                    then g.betrag_cents * m.anteil else 0 end)::bigint as verkaufsgebuehr_cents,
           sum(case when g.fee_typ not in ('FBAPerUnitFulfillmentFee','Commission')
                    then g.betrag_cents * m.anteil else 0 end)::bigint as sonstige_cents,
           bool_or(m.anteil < 1) as anteilig
    from public.finance_gebuehren g
    join sku_map s on s.sku = g.sku
    join lateral (
      select s.asin as asin,
             greatest(0,
               (least(p_bis, (to_date(g.monat,'YYYY-MM') + interval '1 month - 1 day')::date)
                - greatest(p_von, to_date(g.monat,'YYYY-MM')) + 1)
             )::numeric
             / extract(day from (to_date(g.monat,'YYYY-MM') + interval '1 month - 1 day'))::numeric as anteil
    ) m on true
    where g.tenant_id = p_tenant and g.sku <> '' and m.anteil > 0
    group by m.asin
  ),
  keys as (
    select asin from o where asin is not null
    union select asin from r where asin is not null
  )
  select k.asin, coalesce(a.produktname, k.asin),
         coalesce(o.umsatz_cents, 0), coalesce(o.einheiten, 0),
         coalesce(o.wareneinsatz_cents, 0), coalesce(o.einheiten_mit_ek, 0),
         coalesce(r.retouren, 0),
         coalesce(geb.gebuehren_cents, 0),
         (geb.asin is not null) as gebuehren_bekannt,
         coalesce(geb.anteilig, false) as gebuehren_anteilig,
         coalesce(geb.fba_cents, 0),
         coalesce(geb.verkaufsgebuehr_cents, 0),
         coalesce(geb.sonstige_cents, 0)
  from keys k
  left join o on o.asin = k.asin
  left join r on r.asin = k.asin
  left join geb on geb.asin = k.asin
  left join public.asins a on a.tenant_id = p_tenant and a.asin = k.asin
  order by coalesce(o.umsatz_cents,0) desc;
$function$;

revoke all on function public.produkt_uebersicht(uuid, date, date) from public, anon, authenticated;
grant execute on function public.produkt_uebersicht(uuid, date, date) to service_role;;

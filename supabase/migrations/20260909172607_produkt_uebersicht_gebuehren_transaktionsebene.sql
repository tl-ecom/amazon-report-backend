-- produkt_uebersicht bezieht die Gebuehren jetzt aus produkt_gebuehren
-- (Transaktionsebene, nach Bestelldatum) statt aus finance_gebuehren
-- (Monatssumme nach Buchungsdatum, linear umgelegt).
--
-- Neue Spalten:
--   gutschriften_cents        Erstattungen, positiv. NICHT USt.-behaftet und
--                             deshalb getrennt: Wer sie mit den Gebuehren in
--                             einen Topf wirft und durch 1,19 teilt, kuerzt eine
--                             Gutschrift um die Steuer, die nie darauf lag.
--   lager_cents               Lagergebuehren (umgelegt, ohne Bestellbezug)
--   gebuehren_direkt_cents    exakt an Bestellzeilen gebundene Gebuehren
--   gebuehren_umgelegt_cents  Lager + Gutschriften
--   gebuehren_abdeckung       Anteil der Bestellzeilen mit vorliegender Abrechnung
--   gebuehren_vollstaendig    Abdeckung >= 95 %
--
-- `gebuehren_cents` enthaelt weiterhin NUR die USt.-behafteten Gebuehren
-- (Verkaufsgebuehr, FBA, sonstige, Lager). Die Gutschriften kommen erst in
-- produkte.ts dazu, nach der Netto-Umrechnung.
--
-- `gebuehren_anteilig` bedeutet ab jetzt, was es sagt: es ist wahr, wenn
-- umgelegte Betraege in der Summe stecken. Vorher war es die Kalendermonats-
-- Umlage und stand fuer einen vollen Monat auf false, obwohl die Gebuehren aus
-- einer voellig anderen Periode stammten.

drop function if exists public.produkt_uebersicht(uuid, date, date);

create function public.produkt_uebersicht(p_tenant uuid, p_von date, p_bis date default current_date)
returns table(asin text, produktname text, umsatz_cents bigint, einheiten bigint,
              wareneinsatz_cents bigint, einheiten_mit_ek bigint, retouren bigint,
              gebuehren_cents bigint, gebuehren_bekannt boolean, gebuehren_anteilig boolean,
              fba_cents bigint, verkaufsgebuehr_cents bigint, sonstige_gebuehren_cents bigint,
              lager_cents bigint, gutschriften_cents bigint,
              gebuehren_direkt_cents bigint, gebuehren_umgelegt_cents bigint,
              gebuehren_abdeckung numeric, gebuehren_vollstaendig boolean)
language sql
stable
security definer
set search_path to 'public'
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
  geb as (
    select * from public.produkt_gebuehren(p_tenant, p_von, p_bis)
  ),
  keys as (
    select asin from o where asin is not null
    union select asin from r where asin is not null
  )
  select k.asin, coalesce(a.produktname, k.asin),
         coalesce(o.umsatz_cents, 0), coalesce(o.einheiten, 0),
         coalesce(o.wareneinsatz_cents, 0), coalesce(o.einheiten_mit_ek, 0),
         coalesce(r.retouren, 0),
         -- NUR die USt.-behafteten Gebuehren. Gutschriften stehen daneben.
         (coalesce(g.verkaufsgebuehr_cents,0) + coalesce(g.fba_cents,0)
          + coalesce(g.sonstige_cents,0) + coalesce(g.lager_cents,0))::bigint,
         (g.asin is not null) as gebuehren_bekannt,
         (coalesce(g.gebuehren_umgelegt_cents, 0) <> 0) as gebuehren_anteilig,
         coalesce(g.fba_cents, 0),
         coalesce(g.verkaufsgebuehr_cents, 0),
         coalesce(g.sonstige_cents, 0),
         coalesce(g.lager_cents, 0),
         coalesce(g.gutschriften_cents, 0),
         coalesce(g.gebuehren_direkt_cents, 0),
         coalesce(g.gebuehren_umgelegt_cents, 0),
         g.abdeckung,
         (coalesce(g.abdeckung, 0) >= 0.95) as gebuehren_vollstaendig
  from keys k
  left join o on o.asin = k.asin
  left join r on r.asin = k.asin
  left join geb g on g.asin = k.asin
  left join public.asins a on a.tenant_id = p_tenant and a.asin = k.asin
  order by coalesce(o.umsatz_cents,0) desc;
$function$;

revoke all on function public.produkt_uebersicht(uuid, date, date) from public, anon, authenticated;
grant execute on function public.produkt_uebersicht(uuid, date, date) to service_role;

notify pgrst, 'reload schema';;

-- Per-Produkt-Übersicht: Umsatz/Einheiten (Orders) + Wareneinsatz (EK je Bestellung
-- nach Kaufdatum) + Retouren (Returns), je ASIN, ab p_von. Titel aus asins.
create or replace function public.produkt_uebersicht(p_tenant uuid, p_von date)
returns table(asin text, produktname text, umsatz_cents bigint, einheiten bigint,
              wareneinsatz_cents bigint, einheiten_mit_ek bigint, retouren bigint)
language sql stable security definer set search_path = public as $$
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
      and oh.purchase_date::date >= p_von
    group by oh.asin
  ), r as (
    select rh.asin, sum(rh.return_quantity)::bigint as retouren
    from public.returns_history rh
    where rh.tenant_id = p_tenant and rh.return_request_date >= p_von
    group by rh.asin
  ), keys as (
    select asin from o where asin is not null
    union
    select asin from r where asin is not null
  )
  select k.asin,
         coalesce(a.produktname, k.asin) as produktname,
         coalesce(o.umsatz_cents, 0), coalesce(o.einheiten, 0),
         coalesce(o.wareneinsatz_cents, 0), coalesce(o.einheiten_mit_ek, 0),
         coalesce(r.retouren, 0)
  from keys k
  left join o on o.asin = k.asin
  left join r on r.asin = k.asin
  left join public.asins a on a.tenant_id = p_tenant and a.asin = k.asin
  order by coalesce(o.umsatz_cents,0) desc;
$$;

revoke execute on function public.produkt_uebersicht(uuid,date) from anon, authenticated, public;
grant  execute on function public.produkt_uebersicht(uuid,date) to service_role;;

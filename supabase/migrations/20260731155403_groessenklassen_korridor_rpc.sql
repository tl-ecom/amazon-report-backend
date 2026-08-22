-- Datenbasis für Modul 2: Amazons gemessene Maße/Gewichte je SKU plus der
-- tatsächliche Absatz im Fenster. Der Absatz entscheidet, ob ein Zentimeter
-- Verpackung Geld wert ist — ohne ihn wäre die Ersparnis eine Fantasiezahl.
create or replace function public.korridor_produkte(
  p_tenant uuid, p_markt text, p_tage int default 365
)
returns table (
  sku text, asin text, produktname text,
  laengste_seite_cm numeric, mittlere_seite_cm numeric, kuerzeste_seite_cm numeric,
  gewicht_g numeric, groessenklasse text, fulfilment_cents bigint,
  einheiten bigint, fenster_tage int
)
language sql
security definer
set search_path = public
as $$
  with absatz as (
    select o.sku, sum(o.quantity)::bigint as einheiten
    from public.orders_history o
    where o.tenant_id = p_tenant
      and o.sku is not null
      and o.purchase_date >= (current_date - p_tage)
      and coalesce(o.order_status,'') not ilike '%cancel%'
    group by o.sku
  ),
  -- Wie weit reicht die Bestellhistorie wirklich zurueck? Ein 365-Tage-Fenster
  -- ueber 90 Tage Daten wuerde die Jahresersparnis dritteln.
  spanne as (
    select greatest(1, least(
      p_tage,
      (current_date - min(o.purchase_date)::date)
    ))::int as tage
    from public.orders_history o
    where o.tenant_id = p_tenant and o.purchase_date >= (current_date - p_tage)
  )
  select v.sku, v.asin, v.produktname,
         v.laengste_seite_cm, v.mittlere_seite_cm, v.kuerzeste_seite_cm,
         v.gewicht_g, v.groessenklasse, v.fulfilment_cents,
         coalesce(a.einheiten, 0) as einheiten,
         (select tage from spanne) as fenster_tage
  from public.fba_gebuehrenvorschau v
  left join absatz a on a.sku = v.sku
  where v.tenant_id = p_tenant and v.marketplace = p_markt
$$;

revoke all on function public.korridor_produkte(uuid, text, int) from public, anon, authenticated;
grant execute on function public.korridor_produkte(uuid, text, int) to service_role;;

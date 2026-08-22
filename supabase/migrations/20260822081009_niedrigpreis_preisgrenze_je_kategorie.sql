-- Der Niedrigpreisversand (Rate Card S. 5) kennt ZWEI Preisgrenzen, nicht eine:
--   * 20 € (einschl. MwSt.) in den meisten Kategorien
--   * 12 € (einschl. MwSt.) in: Schoenheit/Gesundheit/Koerperpflege,
--     Geschaefts-/Industrie-/Wissenschaftsbedarf, Buerobedarf, Lebensmittel
--     und Feinkost, Buecher, Amazon-Geraetezubehoer, Kueche
--
-- Bisher rechnete Pulse mit einer einzigen Grenze von 20 €. Fuer einen Artikel
-- zu 15 € in einer der genannten Kategorien fiel die Gebuehr damit zu niedrig
-- aus — er laeuft in Wahrheit ueber die (teurere) Standardtabelle.
--
-- An echten Daten nachgewiesen (Vaneja, DE, Klasse "Extra grosser Umschlag"):
--   Warnwesten 4er, Automotive, 15,97 € -> gemessen 3,03 €, Niedrigpreis 3,04 €
--   Trennspray 2er, Grocery,    18,97 € -> gemessen 3,57 €, Standard    3,47 €
-- Gleiche Klasse, gleicher Marktplatz, beide unter 20 € — nur die Kategorie
-- unterscheidet sie. Das ist der Beleg fuer die zweite Grenze.
--
-- Warum eine eigene Tabelle statt einer Konstante im Code: Die Grenzen gehoeren
-- zur Rate Card und aendern sich mit ihr. `fee_schedule.preis_grenze_cents` kann
-- sie nicht tragen — die Grenze haengt an der KATEGORIE, die Zeilen dort an der
-- Groessenklasse.

create table if not exists public.fee_preisgrenze (
  id            uuid primary key default gen_random_uuid(),
  marketplace   text not null,
  -- Amazons `product-group` aus dem Gebuehrenvorschau-Report.
  -- NULL = Vorgabe fuer alle Gruppen ohne eigene Zeile.
  produktgruppe text,
  grenze_cents  bigint not null check (grenze_cents > 0),
  gueltig_ab    date not null,
  quelle        text,
  hinweis       text,
  updated_at    timestamptz not null default now()
);

create unique index if not exists fee_preisgrenze_uniq
  on public.fee_preisgrenze (marketplace, produktgruppe, gueltig_ab)
  nulls not distinct;

alter table public.fee_preisgrenze enable row level security;
-- Bewusst ohne Policies: Zugriff ausschliesslich ueber service_role (Hauskonvention).

comment on table public.fee_preisgrenze is
  'Preisgrenzen des Niedrigpreisversands je Marktplatz und Produktgruppe (Rate Card S. 5). produktgruppe IS NULL = Vorgabe.';

insert into public.fee_preisgrenze (marketplace, produktgruppe, grenze_cents, gueltig_ab, quelle, hinweis)
values
  ('DE', null,                     2000, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Vorgabe: hoechstens 20 € einschl. MwSt.'),
  ('DE', 'Health & Personal Care', 1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Gesundheit und Koerperpflege *'),
  ('DE', 'Beauty',                 1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Schoenheit'),
  ('DE', 'Personal Care Appliances',1200,'2026-07-01', 'FBA Rate Card DE, S. 5', 'Koerperpflege'),
  ('DE', 'Biss',                   1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Geschaefts-, Industrie- und Wissenschaftsbedarf *'),
  ('DE', 'Office Product',         1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Buerobedarf'),
  ('DE', 'Grocery',                1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Lebensmittel *'),
  ('DE', 'Gourmet Food',           1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Feinkost'),
  ('DE', 'Book',                   1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Buecher'),
  ('DE', 'Amazon Device Accessory',1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Amazon-Geraetezubehoer'),
  ('DE', 'Kitchen',                1200, '2026-07-01', 'FBA Rate Card DE, S. 5', 'Kueche *')
on conflict (marketplace, produktgruppe, gueltig_ab) do nothing;

-- Die Produktgruppe wird fuer die Tarifwahl gebraucht; ohne sie ist im Band
-- zwischen beiden Grenzen nicht entscheidbar, welche Tabelle gilt.
drop function if exists public.korridor_produkte(uuid, text, integer);

create function public.korridor_produkte(p_tenant uuid, p_markt text, p_tage integer default 365)
returns table(sku text, asin text, produktname text, produktgruppe text,
              laengste_seite_cm numeric, mittlere_seite_cm numeric, kuerzeste_seite_cm numeric,
              gewicht_g numeric, groessenklasse text, preis_cents bigint,
              fulfilment_cents bigint, einheiten bigint, fenster_tage integer)
language sql
security definer
set search_path to 'public'
as $function$
  with absatz as (
    select o.sku, sum(o.quantity)::bigint as einheiten
    from public.orders_history o
    where o.tenant_id = p_tenant
      and o.sku is not null
      and o.purchase_date >= (current_date - p_tage)
      and coalesce(o.order_status,'') not ilike '%cancel%'
    group by o.sku
  ),
  spanne as (
    select greatest(1, least(
      p_tage,
      (current_date - min(o.purchase_date)::date)
    ))::int as tage
    from public.orders_history o
    where o.tenant_id = p_tenant and o.purchase_date >= (current_date - p_tage)
  )
  select v.sku, v.asin, v.produktname, v.produktgruppe,
         v.laengste_seite_cm, v.mittlere_seite_cm, v.kuerzeste_seite_cm,
         v.gewicht_g, v.groessenklasse,
         coalesce(v.verkaufspreis_cents, v.preis_cents) as preis_cents,
         v.fulfilment_cents,
         coalesce(a.einheiten, 0) as einheiten,
         (select tage from spanne) as fenster_tage
  from public.fba_gebuehrenvorschau v
  left join absatz a on a.sku = v.sku
  where v.tenant_id = p_tenant and v.marketplace = p_markt
$function$;

revoke all on function public.korridor_produkte(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.korridor_produkte(uuid, text, integer) to service_role;

notify pgrst, 'reload schema';;

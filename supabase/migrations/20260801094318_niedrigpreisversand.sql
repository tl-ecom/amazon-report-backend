-- Niedrigpreisversand als eigener Tarif (Rate Card S. 5)
--
-- Befund: Modul 2 hat für JEDES Produkt auf der Standardtabelle gerechnet.
-- Artikel unter der Preisgrenze rechnet Amazon aber nach dem Niedrigpreisversand
-- ab — einer eigenen Tabelle mit eigenen Beträgen, nicht einem Rabatt auf die
-- Standardtabelle. Beim Gegenrechnen fiel das als negative Abweichung auf: Bei
-- Vaneja liegen mehrere Warnwesten-Varianten (9,97 € bis 19,97 €) um 0,43 bis
-- 0,59 € unter dem, was die Standardtabelle sagt.
--
-- Zwei Tabellen brauchen zwei Dimensionen:
--   * `tarif` unterscheidet sie. Die Klassennamen sind in beiden dieselben
--     (StandardEnvelope, LargeEnvelope, ...) — ohne diese Spalte gäbe es keinen
--     Weg, sie auseinanderzuhalten, und der Import der einen würde die andere
--     überschreiben.
--   * `preis_grenze_cents` hält die Grenze dort, wo sie hingehört: in der Rate
--     Card. Sie ändert sich mit ihr und nicht mit einem Deploy. Fehlt sie, gilt
--     der im Code dokumentierte Rückfall (unter 20,00 €).
--
-- Diese Migration legt nur die Struktur an. Die Beträge der S.5-Tabelle pflegt
-- TL über den CSV-Import (Admin -> Gebührentabelle). Solange sie fehlt, weist
-- Modul 2 die betroffenen Produkte als „nicht bewertbar" mit Grund aus — das ist
-- der Punkt: lieber keine Zahl als eine aus der falschen Tabelle.

alter table public.fee_schedule
  add column if not exists tarif text not null default 'standard',
  add column if not exists preis_grenze_cents bigint;

alter table public.fee_schedule
  drop constraint if exists fee_schedule_tarif_check;
alter table public.fee_schedule
  add constraint fee_schedule_tarif_check check (tarif in ('standard', 'niedrigpreis'));

-- Eine Preisgrenze ergibt nur beim Niedrigpreisversand einen Sinn. Auf einer
-- Standardzeile wäre sie ein stiller Pflegefehler, der nirgends auffällt.
alter table public.fee_schedule
  drop constraint if exists fee_schedule_preisgrenze_check;
alter table public.fee_schedule
  add constraint fee_schedule_preisgrenze_check
  check (preis_grenze_cents is null or tarif = 'niedrigpreis');

comment on column public.fee_schedule.tarif is
  'standard = Rate Card S. 6/8, niedrigpreis = Niedrigpreisversand S. 5. Gleiche Klassennamen, andere Beträge.';
comment on column public.fee_schedule.preis_grenze_cents is
  'Nur bei tarif=niedrigpreis: ab diesem Artikelpreis (Cent) gilt wieder der Standardtarif. NULL = Rückfall im Code (2000).';

-- Der Eindeutigkeitsschlüssel muss den Tarif enthalten, sonst kollidiert die
-- Niedrigpreiszeile mit der Standardzeile derselben Klasse und Gewichtsstufe.
drop index if exists public.fee_schedule_stufe_idx;
create unique index fee_schedule_stufe_idx
  on public.fee_schedule (marketplace, tarif, size_tier, gueltig_ab, max_weight_g)
  nulls not distinct;

-- korridor_produkte liefert jetzt den Artikelpreis mit: ohne ihn lässt sich
-- nicht entscheiden, welcher Tarif gilt.
--
-- `verkaufspreis_cents` zuerst — das ist der Preis, den der Kunde zahlt, und an
-- dem die Grenze hängt. `preis_cents` ist der Rückfall, wenn Amazon im
-- Gebührenvorschau-Report keinen Verkaufspreis meldet.
-- Die Rückgabespalten ändern sich (preis_cents kommt dazu); Postgres lässt das
-- über CREATE OR REPLACE nicht zu und verlangt ein DROP.
drop function if exists public.korridor_produkte(uuid, text, integer);

create function public.korridor_produkte(p_tenant uuid, p_markt text, p_tage integer default 365)
returns table(sku text, asin text, produktname text, laengste_seite_cm numeric,
  mittlere_seite_cm numeric, kuerzeste_seite_cm numeric, gewicht_g numeric,
  groessenklasse text, preis_cents bigint, fulfilment_cents bigint,
  einheiten bigint, fenster_tage integer)
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
         v.gewicht_g, v.groessenklasse,
         coalesce(v.verkaufspreis_cents, v.preis_cents) as preis_cents,
         v.fulfilment_cents,
         coalesce(a.einheiten, 0) as einheiten,
         (select tage from spanne) as fenster_tage
  from public.fba_gebuehrenvorschau v
  left join absatz a on a.sku = v.sku
  where v.tenant_id = p_tenant and v.marketplace = p_markt
$function$;

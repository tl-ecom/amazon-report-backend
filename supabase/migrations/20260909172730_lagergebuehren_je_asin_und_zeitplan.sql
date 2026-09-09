-- Lagergebuehren je Produkt: aus fba_lagergebuehren, nicht aus der Abrechnung.
--
-- In settlement_zeilen stehen die Lagergebuehren OHNE SKU (gemessen: 0 von 10
-- Zeilen im August tragen eine). Von dort sind sie einem Produkt grundsaetzlich
-- nicht zuzuordnen. Der Lagergebuehrenbericht kann es, er traegt die ASIN.
--
-- Zweiter Befund: GET_FBA_STORAGE_FEE_CHARGES_DATA stand in KEINEM Zeitplan.
-- Der Bericht lief zuletzt manuell; die juengsten Daten waren vom Juni 2026.
-- Damit fehlte die Lagergebuehr in jeder Produktrechnung seit drei Monaten —
-- ohne dass etwas fehlschlug, es passierte nur nichts. Dieselbe stille Luecke
-- wie beim Bestandsalter.
--
-- Der Bericht ist MONATLICH und braucht einen abgeschlossenen Monat; die
-- sync-report-Konfiguration behandelt das bereits (end_date auf den Monatsersten).

create or replace function public.produkt_gebuehren(
  p_tenant uuid, p_von date, p_bis date default current_date
)
returns table(
  asin text,
  verkaufsgebuehr_cents bigint,
  fba_cents bigint,
  sonstige_cents bigint,
  lager_cents bigint,
  gutschriften_cents bigint,
  gebuehren_direkt_cents bigint,
  gebuehren_umgelegt_cents bigint,
  gebuehren_netto_cents bigint,
  zeilen_gesamt bigint,
  zeilen_mit_gebuehren bigint,
  abdeckung numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with sku_map as (
    select sku, max(asin) as asin from (
      select oh.sku, oh.asin from public.orders_history oh
      where oh.tenant_id = p_tenant and oh.sku is not null and oh.asin is not null
      union
      select f.sku, f.asin from public.fba_bestand f
      where f.tenant_id = p_tenant and f.sku is not null and f.asin is not null
    ) x group by sku
  ),
  best as (
    select o.amazon_order_id, o.sku, o.asin
    from public.orders_history o
    where o.tenant_id = p_tenant
      and o.asin is not null
      and coalesce(o.order_status,'') <> 'Cancelled'
      and o.purchase_date::date between p_von and p_bis
    group by 1,2,3
  ),
  direkt as (
    select b.asin, s.betrag_beschreibung, s.betrag_cents
    from best b
    join public.settlement_zeilen s
      on s.tenant_id = p_tenant
     and s.order_id = b.amazon_order_id
     and s.sku = b.sku
    where s.betrag_typ = 'ItemFees'
       or s.betrag_typ like 'FBA Removal Order%'
  ),
  direkt_agg as (
    select asin,
           sum(case when betrag_beschreibung in ('Commission','RefundCommission')
                    then betrag_cents else 0 end)::bigint as verkaufsgebuehr,
           sum(case when betrag_beschreibung = 'FBAPerUnitFulfillmentFee'
                    then betrag_cents else 0 end)::bigint as fba,
           sum(case when betrag_beschreibung not in
                      ('Commission','RefundCommission','FBAPerUnitFulfillmentFee')
                    then betrag_cents else 0 end)::bigint as sonstige
    from direkt group by asin
  ),
  -- Gutschriften: ohne Bestellbezug, nach Buchungsdatum ins Fenster.
  gutschrift as (
    select m.asin, sum(s.betrag_cents)::bigint as betrag
    from public.settlement_zeilen s
    join sku_map m on m.sku = s.sku
    where s.tenant_id = p_tenant
      and s.gebucht_am between p_von and p_bis
      and s.betrag_typ = 'FBA Inventory Reimbursement'
    group by m.asin
  ),
  -- Lager: monatlich je ASIN, anteilig nach Ueberlappung mit dem Fenster.
  lager as (
    select l.asin,
           sum(l.gesamt_cents * (
             greatest(0,
               (least(p_bis, (to_date(l.monat,'YYYY-MM') + interval '1 month - 1 day')::date)
                - greatest(p_von, to_date(l.monat,'YYYY-MM')) + 1)
             )::numeric
             / extract(day from (to_date(l.monat,'YYYY-MM') + interval '1 month - 1 day'))::numeric
           ))::bigint as betrag
    from public.fba_lagergebuehren l
    where l.tenant_id = p_tenant and l.asin is not null
      and to_date(l.monat,'YYYY-MM') <= p_bis
      and (to_date(l.monat,'YYYY-MM') + interval '1 month - 1 day')::date >= p_von
    group by l.asin
  ),
  deckung as (
    select b.asin,
           count(*)::bigint as zeilen_gesamt,
           count(*) filter (where exists (
             select 1 from public.settlement_zeilen s
             where s.tenant_id = p_tenant and s.order_id = b.amazon_order_id
               and s.sku = b.sku and s.betrag_typ = 'ItemFees'
           ))::bigint as zeilen_mit
    from best b group by b.asin
  ),
  keys as (
    select asin from deckung
    union select asin from gutschrift
    union select asin from lager
  )
  select k.asin,
         coalesce(d.verkaufsgebuehr, 0),
         coalesce(d.fba, 0),
         coalesce(d.sonstige, 0),
         -- Lagergebuehren kommen als POSITIVE Betraege aus dem Bericht; hier
         -- als Kosten, also negativ, damit das Vorzeichen konsistent bleibt.
         (-abs(coalesce(l.betrag, 0)))::bigint,
         coalesce(gu.betrag, 0),
         (coalesce(d.verkaufsgebuehr,0) + coalesce(d.fba,0) + coalesce(d.sonstige,0))::bigint,
         (-abs(coalesce(l.betrag,0)) + coalesce(gu.betrag,0))::bigint,
         (coalesce(d.verkaufsgebuehr,0) + coalesce(d.fba,0) + coalesce(d.sonstige,0)
          - abs(coalesce(l.betrag,0)) + coalesce(gu.betrag,0))::bigint,
         coalesce(g.zeilen_gesamt, 0),
         coalesce(g.zeilen_mit, 0),
         case when coalesce(g.zeilen_gesamt,0) = 0 then null
              else round(g.zeilen_mit::numeric / g.zeilen_gesamt, 3) end
  from keys k
  left join direkt_agg d on d.asin = k.asin
  left join gutschrift gu on gu.asin = k.asin
  left join lager l on l.asin = k.asin
  left join deckung g on g.asin = k.asin;
$function$;

-- Den Lagergebuehrenbericht endlich einplanen.
insert into internal.scheduler_reports (report_type, days, aktiv)
values ('GET_FBA_STORAGE_FEE_CHARGES_DATA', 30, true)
on conflict (report_type) do update set aktiv = true;

notify pgrst, 'reload schema';;

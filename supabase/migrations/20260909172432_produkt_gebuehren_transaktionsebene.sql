-- Gebuehren je ASIN auf TRANSAKTIONSEBENE, dem Bestelldatum zugeordnet.
--
-- Warum das noetig war (nachgewiesen an Vaneja / B0H516MYPV / August 2026):
--
-- Bisher kamen die Gebuehren aus finance_gebuehren. Diese Tabelle ist nach dem
-- MONAT DES FINANZEREIGNISSES (PostedDate) geschluesselt und wurde linear auf
-- das angefragte Fenster umgelegt. Umsatz und Einheiten kommen dagegen aus
-- orders_history nach BESTELLDATUM. Beides sind verschiedene Mengen:
--
--   August, ASIN B0H516MYPV
--     nach Bestelldatum:   68 Einheiten,  1.558,68 EUR Umsatz
--     nach Buchungsdatum: 119 Positionen, 2.229,02 EUR Principal
--
-- Die im August GEBUCHTEN Gebuehren gehoerten also groesstenteils zu Bestellungen
-- aus dem Juli. Pulse stellte sie dem August-Umsatz gegenueber. Ergebnis:
-- 474,13 EUR Verkaufsgebuehr auf 1.558,68 EUR Umsatz = 30 % statt 15 %.
--
-- AUSGESCHLOSSEN (gemessen, nicht vermutet):
--   * keine Doppelzaehlung — Abrechnungsbericht und Finances-API stimmen auf den
--     Cent ueberein, und es gibt null Dubletten ueber Abrechnungen hinweg
--   * keine SKU/ASIN-Vermischung — genau eine SKU zeigt auf diese ASIN
--   * die Umsatzsteuer wird korrekt behandelt: 516,60/1,19 = 434,12 ist exakt
--     der Wert, den Pulse ausgab
--
-- ZWEITE URSACHE: Gutschriften fehlten ganz. finance_gebuehren entsteht aus
-- `FeeAmount`-Knoten der Finances-API; Erstattungen (MISSING_FROM_INBOUND,
-- RE_EVALUATION) tragen andere Feldnamen und kamen nie an. Fuer diese ASIN
-- fehlten dadurch +114,30 EUR.
--
-- AUFBAU
--   direkt    — ItemFees aus settlement_zeilen, ueber order_id + sku an die
--               Bestellung gebunden, nach deren purchase_date datiert. Das ist
--               die exakte Zuordnung, die Vorrang hat.
--   umgelegt  — Lagergebuehren und Gutschriften haben keine Bestellung. Sie
--               werden nach Buchungsdatum ins Fenster genommen und als umgelegt
--               gekennzeichnet, nicht als exakt ausgegeben.
--   abdeckung — wie viele Bestellzeilen des Fensters ueberhaupt schon eine
--               Abrechnung haben. Amazon rechnet mit Verzug ab; fuer den
--               laufenden Monat ist die Quote klein, und dann ist jede
--               Gebuehrenzahl unvollstaendig statt niedrig.
--
-- Alle Betraege BRUTTO wie gebucht (in DE inkl. 19 % USt.). Die Umrechnung auf
-- netto macht weiterhin produkte.ts ueber den gemessenen USt.-Faktor — an einer
-- Stelle, nicht an zweien.

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
  -- Bestellungen des Fensters. Schluessel: Bestellnummer + SKU.
  best as (
    select o.amazon_order_id, o.sku, o.asin
    from public.orders_history o
    where o.tenant_id = p_tenant
      and o.asin is not null
      and coalesce(o.order_status,'') <> 'Cancelled'
      and o.purchase_date::date between p_von and p_bis
    group by 1,2,3
  ),
  -- DIREKT: Gebuehren, die an genau diese Bestellzeilen gebunden sind.
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
  -- UMGELEGT: ohne Bestellbezug, nach Buchungsdatum ins Fenster genommen.
  umgelegt as (
    select m.asin,
           sum(case when s.betrag_typ like '%Storage Fee%' then s.betrag_cents else 0 end)::bigint as lager,
           sum(case when s.betrag_typ = 'FBA Inventory Reimbursement' then s.betrag_cents else 0 end)::bigint as gutschrift
    from public.settlement_zeilen s
    join sku_map m on m.sku = s.sku
    where s.tenant_id = p_tenant
      and s.gebucht_am between p_von and p_bis
      and (s.betrag_typ like '%Storage Fee%' or s.betrag_typ = 'FBA Inventory Reimbursement')
    group by m.asin
  ),
  -- ABDECKUNG: Wie viele Bestellzeilen haben schon eine Abrechnung?
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
    union select asin from umgelegt
  )
  select k.asin,
         coalesce(d.verkaufsgebuehr, 0),
         coalesce(d.fba, 0),
         coalesce(d.sonstige, 0),
         coalesce(u.lager, 0),
         coalesce(u.gutschrift, 0),
         (coalesce(d.verkaufsgebuehr,0) + coalesce(d.fba,0) + coalesce(d.sonstige,0))::bigint,
         (coalesce(u.lager,0) + coalesce(u.gutschrift,0))::bigint,
         (coalesce(d.verkaufsgebuehr,0) + coalesce(d.fba,0) + coalesce(d.sonstige,0)
          + coalesce(u.lager,0) + coalesce(u.gutschrift,0))::bigint,
         coalesce(g.zeilen_gesamt, 0),
         coalesce(g.zeilen_mit, 0),
         case when coalesce(g.zeilen_gesamt,0) = 0 then null
              else round(g.zeilen_mit::numeric / g.zeilen_gesamt, 3) end
  from keys k
  left join direkt_agg d on d.asin = k.asin
  left join umgelegt u on u.asin = k.asin
  left join deckung g on g.asin = k.asin;
$function$;

revoke all on function public.produkt_gebuehren(uuid, date, date) from public, anon, authenticated;
grant execute on function public.produkt_gebuehren(uuid, date, date) to service_role;

notify pgrst, 'reload schema';;

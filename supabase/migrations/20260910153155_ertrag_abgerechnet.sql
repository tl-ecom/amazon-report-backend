-- Ertrag ueber ein Fenster, das Amazon schon abgerechnet hat.
--
-- Das Problem: Umsatz und Wareneinsatz stehen sofort fest, die GEBUEHREN
-- kommen mit Wochen Verzug. In den letzten 30 Kalendertagen sind bei Vaneja
-- erst 41 % der Bestellungen abgerechnet — der Ertrag faellt dadurch um ein
-- Vielfaches zu hoch aus (26.748 € statt rund 16.000 €).
--
-- Das laesst sich nicht durch besseres Abrufen loesen. Die Daten existieren
-- schlicht noch nicht. Loesbar ist es nur, indem man ein Fenster nimmt, das
-- fertig ist — und offen dazusagt, dass es aelter ist.
--
-- Der Versatz wird GEMESSEN, nicht gesetzt: aus der Verteilung "Tage von der
-- Bestellung bis zur Abrechnung" das 90-Prozent-Quantil. Bei Vaneja sind das
-- rund 25 Tage (DD+7 plus Abrechnungsperiode). Ein fester Wert waere bei einem
-- anderen Konto falsch.
create or replace function public.ertrag_abgerechnet(
  p_tenant uuid,
  p_tage integer default 30
)
returns table(
  von date,
  bis date,
  versatz_tage integer,
  umsatz_netto_cents bigint,
  wareneinsatz_cents bigint,
  gebuehren_cents bigint,
  werbung_cents bigint,
  ertrag_cents bigint,
  abdeckung numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with lauf as (
    -- Wie lange dauert es von der Bestellung bis zur Abrechnung? Gemessen an
    -- den Zeilen, die bereits eine Abrechnung haben.
    select (s.gebucht_am - o.purchase_date::date) as tage
    from public.settlement_zeilen s
    join public.orders_history o
      on o.tenant_id = p_tenant and o.amazon_order_id = s.order_id
    where s.tenant_id = p_tenant
      and s.betrag_beschreibung = 'Principal'
      and s.gebucht_am >= current_date - 120
      and s.gebucht_am >= o.purchase_date::date
      and (s.gebucht_am - o.purchase_date::date) between 0 and 60
  ),
  versatz as (
    -- 90-Prozent-Quantil, mindestens 14 und hoechstens 45 Tage. Die Grenzen
    -- verhindern Unsinn bei duennen Daten, ohne die Messung zu ersetzen.
    select greatest(14, least(45,
      coalesce((select percentile_disc(0.9) within group (order by tage)::int from lauf), 25)
    )) as tage
  ),
  fenster as (
    select (current_date - v.tage - p_tage)::date as von,
           (current_date - v.tage)::date as bis,
           v.tage as versatz
    from versatz v
  ),
  p as (
    select f.von, f.bis, f.versatz,
           coalesce(sum(pu.umsatz_cents),0)::bigint as umsatz,
           coalesce(sum(pu.wareneinsatz_cents),0)::bigint as ek,
           coalesce(sum(pu.gebuehren_cents),0)::bigint as geb,
           -- Umsatzgewichtet: ein kleines Produkt mit einer abgerechneten
           -- Bestellung darf den Schnitt nicht genauso heben wie der
           -- Umsatztraeger.
           coalesce(round((sum(pu.umsatz_cents * pu.gebuehren_abdeckung)
                           / nullif(sum(pu.umsatz_cents),0))::numeric, 3), 0) as abd
    from fenster f
    left join lateral public.produkt_uebersicht(p_tenant, f.von, f.bis) pu on true
    group by f.von, f.bis, f.versatz
  ),
  w as (
    select coalesce(sum(a.spend_cents),0)::bigint as werbung
    from fenster f
    left join lateral public.ads_summen(p_tenant, f.von, f.bis) a on true
    where a.ebene = 'gesamt'
  )
  select p.von, p.bis, p.versatz,
         p.umsatz, p.ek, p.geb, w.werbung,
         -- Gebuehren kommen negativ, Werbung positiv aus den Quellen.
         (p.umsatz - p.ek + p.geb - w.werbung)::bigint,
         p.abd
  from p, w;
$function$;

revoke all on function public.ertrag_abgerechnet(uuid, integer) from public, anon, authenticated;
grant execute on function public.ertrag_abgerechnet(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

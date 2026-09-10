-- Korrektur an cashflow_geldlauf: die Auszahlungsquote war falsch gemessen.
--
-- Erste Fassung: Summe der Auszahlungen geteilt durch den Bruttoumsatz eines
-- versetzten Fensters. Ergebnis 33,3 %. An Sellerboards August-Rechnung
-- gegengeprueft muessten es rund 46 % sein (29.456 € erwartete Auszahlung auf
-- 64.092 € Umsatz) — die Prognose waere um ein Drittel zu klein ausgefallen.
--
-- Der Fehler lag in den beweglichen Teilen: Auszahlungen zaehlen nur die
-- Hauptreihe mit positivem Betrag, das Umsatzfenster war anders geschnitten,
-- und Abzuege aus frueheren Perioden liefen mit.
--
-- Neu: die Quote kommt aus den POSTEN eines Monats — Bruttoumsatz minus
-- Gebuehren minus Werbung, alles nach Bestelldatum. An Vanejas Juli gemessen:
-- 47,0 %, und der Juli ist zu 86 % abgerechnet. Das passt zu Sellerboard.
--
-- Die Auswahl des Monats trifft cashflow_geldlauf.ts: nur ein hinreichend
-- abgerechneter Monat taugt als Grundlage, und diese Regel gehoert dorthin,
-- wo sie getestet werden kann.
create or replace function public.cashflow_quote_je_monat(
  p_tenant uuid,
  p_monate integer default 4
)
returns table(
  monat text,
  umsatz_brutto_cents bigint,
  gebuehren_cents bigint,
  werbung_cents bigint,
  abdeckung numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with monate as (
    select to_char(g, 'YYYY-MM') as monat,
           g::date as von,
           (g + interval '1 month' - interval '1 day')::date as bis
    from generate_series(
      date_trunc('month', current_date) - make_interval(months => p_monate),
      date_trunc('month', current_date),
      interval '1 month'
    ) g
  )
  select m.monat,
         coalesce((
           select sum(o.item_price_cents)::bigint from public.orders_history o
           where o.tenant_id = p_tenant
             and o.purchase_date >= m.von and o.purchase_date < m.bis + 1
             and coalesce(o.order_status,'') not ilike '%cancel%'
         ), 0),
         coalesce((select sum(p.gebuehren_cents)::bigint
                   from public.produkt_uebersicht(p_tenant, m.von, m.bis) p), 0),
         coalesce((select sum(a.spend_cents)::bigint
                   from public.ads_summen(p_tenant, m.von, m.bis) a
                   where a.ebene = 'gesamt'), 0),
         coalesce((select round(avg(p.gebuehren_abdeckung)::numeric, 3)
                   from public.produkt_uebersicht(p_tenant, m.von, m.bis) p
                   where p.gebuehren_abdeckung is not null), 0)
  from monate m
  order by m.monat desc;
$function$;

revoke all on function public.cashflow_quote_je_monat(uuid, integer) from public, anon, authenticated;
grant execute on function public.cashflow_quote_je_monat(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

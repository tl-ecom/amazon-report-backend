-- Die Umsatzsteuer aus den VERKAEUFEN fehlte in der Cash-Sicht. Sie ist bei
-- Vaneja der groesste einzelne Abfluss: im August 9.083 € vereinnahmt gegen
-- 3.630 € Vorsteuer aus Gebuehren (nachgerechnet, nicht geschaetzt). Amazon zahlt den Bruttoumsatz aus, aber die
-- Steuer darin gehoert dem Finanzamt — wer sie als Guthaben liest, plant mit
-- Geld, das ihm nicht gehoert.
--
-- Die Saetze muessen dabei NICHT unterstellt werden: Amazon bucht den
-- tatsaechlichen Steuerbetrag je Zeile. Damit stimmt die Rechnung auch fuer
-- Sortimente mit 7 % und 19 % nebeneinander, ohne dass jemand pflegen muss,
-- welcher Artikel in welchen Satz faellt.
--
-- Vier Bestandteile, alle vorzeichenrichtig aus dem Bericht:
--   ItemPrice/Tax, ShippingTax, GiftWrapTax   vereinnahmt (Refunds negativ)
--   Promotion/TaxDiscount                     mindert
--   ItemWithheldTax                           hat Amazon selbst abgefuehrt
-- Der letzte Posten ist der heikle: ohne ihn wuerde Pulse Steuer als Schuld
-- ausweisen, die Amazon bereits an den Fiskus gezahlt hat.
--
-- Der Marktplatz kommt mit, weil Auslandsumsaetze in die OSS-Meldung gehoeren
-- und nicht in die deutsche Voranmeldung. Er ist ein NAEHERUNGSWERT fuer das
-- Steuerland, kein Beweis: ein Fernverkauf ueber Amazon.de an einen
-- franzoesischen Kunden traegt franzoesische Steuer. Genau steht das erst im
-- Umsatzsteuer-Transaktionsbericht, den Pulse (noch) nicht holt.
create or replace function public.cashflow_umsatzsteuer(
  p_tenant uuid,
  p_tage integer default 120
)
returns table(
  monat text, marktplatz text,
  vereinnahmt_cents bigint,
  einbehalten_cents bigint,
  vorsteuer_ausgewiesen_cents bigint,
  gebuehren_brutto_cents bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select to_char(s.gebucht_am,'YYYY-MM') as monat,
         coalesce(s.marktplatz,'unbekannt') as marktplatz,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_beschreibung in ('Tax','ShippingTax','GiftWrapTax','TaxDiscount')
         ),0)::bigint,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ = 'ItemWithheldTax'
         ),0)::bigint,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_beschreibung = 'Tax on fee'
         ),0)::bigint,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ = 'ItemFees'
         ),0)::bigint
  from public.settlement_zeilen s
  where s.tenant_id = p_tenant
    and s.gebucht_am >= (current_date - p_tage)
  group by 1,2
  having coalesce(sum(s.betrag_cents) filter (
           where s.betrag_beschreibung in ('Tax','ShippingTax','GiftWrapTax','TaxDiscount')
              or s.betrag_typ in ('ItemWithheldTax','ItemFees')
              or s.betrag_beschreibung = 'Tax on fee'
         ),0) <> 0
  order by 1 desc, 2;
$function$;

revoke all on function public.cashflow_umsatzsteuer(uuid, integer) from public, anon, authenticated;
grant execute on function public.cashflow_umsatzsteuer(uuid, integer) to service_role;

notify pgrst, 'reload schema';;

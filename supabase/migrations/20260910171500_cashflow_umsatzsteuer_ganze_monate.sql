-- Das Fenster schnitt mitten in einen Monat. Fuer einen monatlichen Anmelder war
-- das harmlos (der Randmonat liegt lange hinter dem naechsten Termin), fuer einen
-- QUARTALSWEISEN nicht: bei 60 Tagen Fenster begann der Juli am 12., und die
-- Zahllast fuer Q3 fiel um zwei Wochen Umsatz zu niedrig aus — ohne jeden Hinweis.
--
-- Jetzt beginnt das Fenster am Monatsersten. Ein enthaltener Monat ist damit
-- immer vollstaendig, und ein fehlender faellt beim Aufsummieren auf.
create or replace function public.cashflow_umsatzsteuer(p_tenant uuid, p_tage integer default 120)
returns table(monat text, marktplatz text, vereinnahmt_cents bigint, einbehalten_cents bigint,
              vorsteuer_ausgewiesen_cents bigint, gebuehren_brutto_cents bigint)
language sql stable security definer set search_path to 'public'
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
    -- Auf den Monatsersten gerundet: ein halber Monat ist schlimmer als keiner.
    and s.gebucht_am >= date_trunc('month', current_date - p_tage)
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

notify pgrst, 'reload schema';

-- Tagesreihe je ASIN fuer die Bestandshistorie.
--
-- Aggregiert wird ueber SKUs und Orte: ein Produkt ist ausverkauft, wenn im
-- gesamten Netz keine verkaufsfaehige Einheit mehr liegt. Gezaehlt wird nur die
-- Disposition SELLABLE — defekte oder beschaedigte Ware ist nicht lieferbar.
--
-- `verkauft` kommt aus derselben Zeile (Customer Shipments) und wird als Betrag
-- gelesen: Amazon fuehrt Abgaenge negativ, das Vorzeichen ist hier egal.
--
-- Eine Zeile entsteht nur fuer Tage, an denen Amazon ueberhaupt etwas gemeldet
-- hat. Das Fortschreiben der Luecken passiert bewusst NICHT hier, sondern in
-- bestandshistorie.ts — dort ist es getestet und dokumentiert.
create or replace function public.bestandsverlauf_basis(p_tenant uuid, p_von date)
returns table (asin text, datum date, menge bigint, verkauft bigint)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(nullif(v.asin, ''), 'SKU:' || v.sku) as asin,
    v.datum,
    coalesce(sum(v.end_menge) filter (where v.disposition ilike 'sellable'), 0)::bigint as menge,
    coalesce(sum(abs(coalesce(v.kundenversand, 0))), 0)::bigint as verkauft
  from public.fba_bestand_verlauf v
  where v.tenant_id = p_tenant
    and v.datum >= p_von
  group by 1, 2
  order by 1, 2
$$;

revoke all on function public.bestandsverlauf_basis(uuid, date) from public, anon, authenticated;
grant execute on function public.bestandsverlauf_basis(uuid, date) to service_role;;

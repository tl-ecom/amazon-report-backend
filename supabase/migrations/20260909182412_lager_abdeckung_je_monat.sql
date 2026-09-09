-- Welche Monate eines Zeitfensters haben ueberhaupt Lagergebuehren?
--
-- Anlass: Amazon gibt den Lagergebuehrenbericht erst mit Wochen Verzug heraus.
-- Fehlt ein Monat, summiert die Produktsicht 0 Cent Lagerkosten — und 0,00 €
-- liest sich wie "keine Lagerkosten", nicht wie "unbekannt". Ueber MCP oder
-- ChatGPT sieht niemand die Datenlage dahinter; er sieht nur die Zahl. Marge
-- und Gewinn fallen dann zu guenstig aus, ohne dass es auffaellt.
--
-- Diese Funktion beantwortet genau eine Frage, damit die Antwort es selbst
-- sagen kann: fuer welche Monate liegen Daten vor, fuer welche nicht.
-- `betrag_cents` kommt mit, damit ein "hat_daten = true" mit 0 € (echte Null)
-- von einem fehlenden Monat unterscheidbar bleibt.
create or replace function public.lager_abdeckung(
  p_tenant uuid,
  p_von date,
  p_bis date default current_date
)
returns table(monat text, hat_daten boolean, betrag_cents bigint)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with monate as (
    select to_char(g, 'YYYY-MM') as monat
    from generate_series(
      date_trunc('month', p_von),
      date_trunc('month', p_bis),
      interval '1 month'
    ) g
  )
  select m.monat,
         exists (
           select 1 from public.fba_lagergebuehren l
           where l.tenant_id = p_tenant and l.monat = m.monat
         ),
         coalesce((
           select sum(l.gesamt_cents)::bigint from public.fba_lagergebuehren l
           where l.tenant_id = p_tenant and l.monat = m.monat
         ), 0)
  from monate m
  order by m.monat;
$function$;

revoke all on function public.lager_abdeckung(uuid, date, date) from public, anon, authenticated;
grant execute on function public.lager_abdeckung(uuid, date, date) to service_role;

notify pgrst, 'reload schema';

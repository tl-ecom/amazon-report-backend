-- Welche Gebührentypen kommen real in den Finanzdaten vor? Grundlage für die
-- Admin-Liste "noch nicht klassifiziert". Plattformweit (über alle Firmen), weil
-- die Klassifizierung plattformweit gilt — Beträge bewusst nur als Summe, damit
-- die Liste keine Firmenzahlen preisgibt.
create or replace function public.fee_typen_gesehen()
returns table (fee_typ text, summe_cents bigint, firmen int)
language sql
security definer
set search_path = public
as $$
  select g.fee_typ,
         sum(g.betrag_cents)::bigint          as summe_cents,
         count(distinct g.tenant_id)::int     as firmen
  from public.finance_gebuehren g
  group by g.fee_typ
  order by abs(sum(g.betrag_cents)) desc
$$;

revoke all on function public.fee_typen_gesehen() from public, anon, authenticated;
grant execute on function public.fee_typen_gesehen() to service_role;;

-- Marktplatz-ID -> Länderkürzel. Nur die europäischen, die Pulse bedient.
create or replace function public.marktplatz_land(p_id text)
returns text language sql immutable as $$
  select case p_id
    when 'A1PA6795UKMFR9' then 'DE'
    when 'A13V1IB3VIYZZH' then 'FR'
    when 'APJ6JRA9NG5V4'  then 'IT'
    when 'A1RKKUPIHCS9HS' then 'ES'
    when 'A1F83G8C2ARO7P' then 'UK'
    when 'A1805IZSGTT6HS' then 'NL'
    when 'A2NODRKZP88ZB9' then 'SE'
    when 'A1C3SOZRARQ6R3' then 'PL'
    when 'AMEN7PMS3EDWL'  then 'BE'
    when 'A28R8C7NBKEWEA' then 'IE'
    else null end
$$;

-- Vergleichspaare, jetzt NUR vom Heimatmarktplatz.
-- Grund: Bei grenzueberschreitendem Versand (EFN) berechnet Amazon eine ganz
-- andere Gebuehr als die Inlandsgebuehr, die der Vorschau-Report nennt — bei
-- Vaneja ergab der FR-Vergleich 2,30 statt 1,19. Das ist keine Steuer, das ist
-- ein falscher Vergleich. Ausserdem gilt am Heimatmarkt der eigene Steuersatz.
create or replace function public.ust_faktor_paare(p_tenant uuid)
returns table (sku text, brutto_cents bigint, netto_cents bigint)
language sql
security definer
set search_path = public
as $$
  with heimat as (
    select public.marktplatz_land(a.marketplace_id) as land
    from public.auth_contexts a
    where a.tenant_id = p_tenant and a.marketplace_id is not null
    limit 1
  )
  select s.sku,
         (-s.betrag_cents)::bigint as brutto_cents,
         v.fulfilment_cents        as netto_cents
  from public.settlement_zeilen s
  join heimat h on true
  join public.fba_gebuehrenvorschau v
    on v.tenant_id = s.tenant_id and v.sku = s.sku and v.marketplace = h.land
  where s.tenant_id = p_tenant
    and upper(split_part(s.marktplatz, '.', 2)) = h.land
    and s.betrag_beschreibung = 'FBAPerUnitFulfillmentFee'
    and s.menge = 1
    and s.betrag_cents < 0
    and v.fulfilment_cents > 0
$$;

revoke all on function public.ust_faktor_paare(uuid) from public, anon, authenticated;
grant execute on function public.ust_faktor_paare(uuid) to service_role;;

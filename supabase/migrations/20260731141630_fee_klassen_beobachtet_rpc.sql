-- Welche Größenklassen kommen real vor und fehlen in der gepflegten Tabelle?
-- Damit bekommt der Admin eine echte Arbeitsliste, statt dass Pulse
-- Platzhalterzeilen mit erfundenem Gültigkeitsdatum anlegt.
create or replace function public.fee_klassen_beobachtet()
returns table (
  marketplace text,
  groessenklasse text,
  skus int,
  gebuehr_min_cents bigint,
  gebuehr_max_cents bigint,
  gepflegt boolean
)
language sql
security definer
set search_path = public
as $$
  select v.marketplace,
         v.groessenklasse,
         count(*)::int                        as skus,
         min(v.fulfilment_cents)              as gebuehr_min_cents,
         max(v.fulfilment_cents)              as gebuehr_max_cents,
         exists (
           select 1 from public.fee_schedule s
           where s.marketplace = v.marketplace and s.size_tier = v.groessenklasse
         )                                    as gepflegt
  from public.fba_gebuehrenvorschau v
  where v.groessenklasse is not null
  group by v.marketplace, v.groessenklasse
  order by v.marketplace, count(*) desc
$$;

revoke all on function public.fee_klassen_beobachtet() from public, anon, authenticated;
grant execute on function public.fee_klassen_beobachtet() to service_role;;

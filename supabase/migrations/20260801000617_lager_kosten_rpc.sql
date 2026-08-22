-- Was kostet mein Lager, und woran liegt es?
-- Kombiniert Lagergebühr je ASIN mit dem Bestandsalter. Erst zusammen ist es
-- handlungsfähig: eine hohe Gebühr bei frischem Bestand ist normal, dieselbe
-- Gebühr bei Ware ab dem vierten Monat ist ein Fall fürs Coaching.
create or replace function public.lager_kosten(p_tenant uuid)
returns table (
  asin text, produktname text, monat text,
  gebuehr_cents bigint, zuschlag_cents bigint,
  frisch numeric, alt numeric, anteil_alt numeric,
  gebuehr_alt_cents bigint, alter_bekannt boolean
)
language sql stable security definer set search_path to 'public'
as $$
  with alter_je_asin as (
    select asin,
           sum(coalesce(alter_0_30,0)+coalesce(alter_31_60,0)+coalesce(alter_61_90,0)) as frisch,
           sum(coalesce(alter_91_180,0)+coalesce(alter_181_270,0)
               +coalesce(alter_271_365,0)+coalesce(alter_365_plus,0)) as alt
    from public.fba_bestandsalter
    where tenant_id = p_tenant and asin is not null
    group by asin
  ),
  lager as (
    select l.asin, l.monat,
           sum(l.gesamt_cents - coalesce(l.zuschlag_cents,0))::bigint as basis_cents,
           sum(coalesce(l.zuschlag_cents,0))::bigint as zuschlag_cents,
           max(l.produktname) as produktname
    from public.fba_lagergebuehren l
    where l.tenant_id = p_tenant and l.asin is not null
    group by l.asin, l.monat
  )
  select l.asin,
         coalesce(a.produktname, l.produktname, l.asin) as produktname,
         l.monat, l.basis_cents, l.zuschlag_cents,
         coalesce(g.frisch, 0), coalesce(g.alt, 0),
         case when coalesce(g.frisch,0) + coalesce(g.alt,0) > 0
              then round(g.alt / (g.frisch + g.alt), 4) else null end as anteil_alt,
         -- Coaching-Regel: Anteil des Bestands ab dem 4. Monat, auf die
         -- Basisgebuehr angewandt. Ohne bekanntes Alter: 0, nicht geschaetzt.
         case when coalesce(g.frisch,0) + coalesce(g.alt,0) > 0
              then round(l.basis_cents * g.alt / (g.frisch + g.alt))::bigint else 0 end,
         (g.asin is not null) as alter_bekannt
  from lager l
  left join alter_je_asin g on g.asin = l.asin
  left join public.asins a on a.tenant_id = p_tenant and a.asin = l.asin
  order by l.basis_cents desc
$$;

revoke all on function public.lager_kosten(uuid) from public, anon, authenticated;
grant execute on function public.lager_kosten(uuid) to service_role;;

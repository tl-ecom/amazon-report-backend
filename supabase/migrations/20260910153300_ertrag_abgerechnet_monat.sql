-- Ertrag je KALENDERMONAT statt ueber ein gleitendes Fenster.
--
-- Erster Entwurf war ein versetztes Fenster: heute minus gemessener Geldlauf,
-- 30 Tage zurueck. Das brachte 28.07.–27.08. mit 78,6 % Abdeckung — immer noch
-- unter der Schwelle, und der Zeitraum liess sich niemandem erklaeren.
--
-- Kalendermonate sind besser: "Juli 2026" versteht jeder, es deckt sich mit
-- Sellerboard und mit der Buchhaltung, und ein Monat ist entweder abgerechnet
-- oder nicht — dazwischen gibt es nichts zu interpretieren.
--
-- Regel: der JUENGSTE Monat, der hinreichend abgerechnet ist. Bei Vaneja heute
-- also Juli (86 %) und nicht August (55 %). Erreicht kein Monat die Schwelle,
-- kommt NICHTS heraus statt des am wenigsten schlechten.
create or replace function public.ertrag_abgerechnet(
  p_tenant uuid,
  p_min_abdeckung numeric default 0.8
)
returns table(
  monat text,
  von date,
  bis date,
  umsatz_netto_cents bigint,
  wareneinsatz_cents bigint,
  gebuehren_cents bigint,
  werbung_cents bigint,
  ertrag_cents bigint,
  abdeckung numeric,
  monate_geprueft integer
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
    -- Sechs Monate zurueck: mehr braucht niemand, und jeder Monat kostet einen
    -- Durchlauf durch produkt_uebersicht.
    from generate_series(
      date_trunc('month', current_date) - interval '6 months',
      date_trunc('month', current_date),
      interval '1 month'
    ) g
    where g < date_trunc('month', current_date)
  ),
  werte as (
    select m.monat, m.von, m.bis,
           coalesce(sum(pu.umsatz_cents),0)::bigint as umsatz,
           coalesce(sum(pu.wareneinsatz_cents),0)::bigint as ek,
           coalesce(sum(pu.gebuehren_cents),0)::bigint as geb,
           -- Umsatzgewichtet: ein kleines Produkt mit einer abgerechneten
           -- Bestellung darf den Schnitt nicht so heben wie der Umsatztraeger.
           coalesce(round((sum(pu.umsatz_cents * pu.gebuehren_abdeckung)
                           / nullif(sum(pu.umsatz_cents),0))::numeric, 3), 0) as abd
    from monate m
    left join lateral public.produkt_uebersicht(p_tenant, m.von, m.bis) pu on true
    group by m.monat, m.von, m.bis
  ),
  gewaehlt as (
    select * from werte
    where abd >= p_min_abdeckung and umsatz > 0
    order by monat desc
    limit 1
  )
  select g.monat, g.von, g.bis,
         g.umsatz, g.ek, g.geb,
         coalesce((select sum(a.spend_cents)::bigint
                   from public.ads_summen(p_tenant, g.von, g.bis) a
                   where a.ebene = 'gesamt'), 0),
         (g.umsatz - g.ek + g.geb
          - coalesce((select sum(a.spend_cents)::bigint
                      from public.ads_summen(p_tenant, g.von, g.bis) a
                      where a.ebene = 'gesamt'), 0))::bigint,
         g.abd,
         (select count(*)::int from werte)
  from gewaehlt g;
$function$;

revoke all on function public.ertrag_abgerechnet(uuid, numeric) from public, anon, authenticated;
grant execute on function public.ertrag_abgerechnet(uuid, numeric) to service_role;

drop function if exists public.ertrag_abgerechnet(uuid, integer);

notify pgrst, 'reload schema';;

-- Search-Query-Performance lueckenlos fuer die verwalteten Produkte.
--
-- cron_sqp_batch holt je Lauf fuer zwei der zehn meistverkauften ASINs die
-- NEUESTE Woche. Jede ASIN kommt so etwa alle fuenf Tage dran — Wochen fallen
-- aus, eine zu frueh angefragte Woche wird nicht nachgeholt, und ASINs
-- ausserhalb der zehn (Vanejas Kauknochen) kommen nie. Der Kaufanteil je
-- Suchbegriff (sqp_produkt_verlauf) vergleicht aber Woche mit Woche.
--
-- Dieser Lauf holt fuer die ASINs der verwalteten Produkte (Zuordnung wie
-- ads_produkt_lage) die fehlenden der letzten acht abgeschlossenen Wochen,
-- die neueste zuerst, hoechstens drei Abrufe je Mandant und Tag. Liest nur
-- bei Amazon (Brand Analytics), schreibt dort nichts.
create or replace function internal.sqp_produkte_faellig(p_max integer default 3)
returns table(tenant_id uuid, marktplatz text, asin text, von date, bis date)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  with mandanten as (
    select distinct s.tenant_id,
           (select ac.marketplace_id from public.auth_contexts ac
             where ac.tenant_id = s.tenant_id and ac.source = 'sp' and ac.status = 'connected' limit 1) as mp
      from public.ads_steuerung s
  ),
  ende as (
    select m.tenant_id, m.mp, (select max(datum) from public.ads_daily a
                                where a.tenant_id = m.tenant_id and a.marktplatz = m.mp) as d
      from mandanten m where m.mp is not null
  ),
  produkt_asins as (
    select distinct e.tenant_id, e.mp, s.produkt, a.asin
      from ende e
      join public.ads_steuerung s on s.tenant_id = e.tenant_id and s.modus <> 'nur_analyse' and s.produkt is not null
      join public.ads_daily a on a.tenant_id = e.tenant_id and a.campaign_id = s.campaign_id
                             and a.marktplatz = e.mp and a.asin <> '' and a.datum > e.d - 90
  ),
  asins as (
    select tenant_id, mp, asin from produkt_asins group by 1, 2, 3 having count(distinct produkt) = 1
  ),
  -- Amazon veroeffentlicht eine Woche (Sonntag bis Samstag) erst einige Tage
  -- nach ihrem Ende. Drei Tage Abstand; vorher lehnt Amazon den Report ab.
  letzter_samstag as (
    select (current_date - 3) - ((extract(dow from current_date - 3)::int + 1) % 7) as sa
  ),
  wochen as (
    select (sa - 6 - 7 * i) as von, (sa - 7 * i) as bis from letzter_samstag, generate_series(0, 7) i
  ),
  offen as (
    select a.tenant_id, a.mp, a.asin, w.von, w.bis,
           (select coalesce(sum(o.quantity), 0) from public.orders_history o
             where o.tenant_id = a.tenant_id and o.asin = a.asin and o.purchase_date > now() - interval '90 days') as stueck
      from asins a cross join wochen w
     where not exists (select 1 from public.sqp_rows r
                        where r.tenant_id = a.tenant_id and r.asin = a.asin and r.periode = 'WEEK'
                          and r.marktplatz = a.mp and r.zeitraum_von = w.von)
       -- Laeuft gerade, oder ist vor kurzem gescheitert bzw. leer geblieben: nicht taeglich wiederholen.
       and not exists (select 1 from public.sqp_laeufe l
                        where l.tenant_id = a.tenant_id and l.asin = a.asin and l.periode = 'WEEK'
                          and l.marktplatz = a.mp and l.zeitraum_von = w.von
                          and (   (l.status = 'laeuft' and l.gestartet > now() - interval '6 hours')
                               or (l.status in ('fehler', 'leer') and l.gestartet > now() - interval '7 days')))
       -- ASIN ganz ohne Daten, die in den letzten 14 Tagen schon einmal nichts lieferte
       -- (keine Marke eingetragen, zu neu): hoechstens alle 14 Tage wieder versuchen.
       and not (    not exists (select 1 from public.sqp_rows r
                                 where r.tenant_id = a.tenant_id and r.asin = a.asin and r.marktplatz = a.mp)
                and exists (select 1 from public.sqp_laeufe l
                             where l.tenant_id = a.tenant_id and l.asin = a.asin and l.marktplatz = a.mp
                               and l.status in ('fehler', 'leer') and l.gestartet > now() - interval '14 days'))
  )
  select x.tenant_id, x.mp, x.asin, x.von, x.bis
    from (select o.*, row_number() over (partition by o.tenant_id order by o.von desc, o.stueck desc, o.asin) as rn
            from offen o) x
   where x.rn <= greatest(1, least(coalesce(p_max, 3), 10))
$function$;

create or replace function internal.cron_sqp_produkte()
returns integer
language plpgsql security definer set search_path to 'public', 'internal'
as $function$
declare r record; n int := 0;
begin
  for r in select * from internal.sqp_produkte_faellig(3) loop
    perform public.sqp_anstossen(r.tenant_id, r.asin, 'WEEK', r.von, r.bis, r.marktplatz);
    n := n + 1;
  end loop;
  return n;
end
$function$;

revoke all on function internal.sqp_produkte_faellig(integer) from public, anon, authenticated;
revoke all on function internal.cron_sqp_produkte() from public, anon, authenticated;

-- Eine halbe Stunde nach dem bestehenden Lauf (04:00 UTC), damit sich die Abrufe nicht stapeln.
select cron.schedule('sync-sqp-produkte-taeglich', '30 4 * * *', 'select internal.cron_sqp_produkte()');

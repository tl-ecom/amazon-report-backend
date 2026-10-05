-- Kaufanteil je Suchbegriff und Woche fuer die verwalteten Produkte, aus den
-- schon abgerufenen Search-Query-Performance-Wochen (sqp_rows). Trennt
-- "die Nachfrage ist gefallen" von "unser Anteil ist gefallen".
--
-- Ein Produkt = seine ASINs (Zuordnung wie ads_produkt_lage). Je Suchbegriff
-- und Woche: Suchvolumen (bei mehreren ASINs dasselbe, deshalb max) und
-- Kaufanteil (je ASIN, deshalb Summe).
--
-- Amazon liefert je ASIN und Woche nur die 100 wichtigsten Begriffe, und
-- welche das sind, wechselt. Die Wochensumme ueber alle Begriffe waere deshalb
-- kein Verlauf. "kern" sind die Begriffe, die in JEDER vorhandenen Woche des
-- Produkts stehen — nur ueber sie laesst sich Woche mit Woche vergleichen.
create or replace function public.sqp_produkt_verlauf(
  p_tenant uuid, p_marktplatz text, p_top integer default 15
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with ende as (
    select max(datum) as d from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  produkt_asins as (
    select distinct s.produkt, a.asin
      from public.ads_steuerung s cross join ende
      join public.ads_daily a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz and a.asin <> ''
                             and a.datum > ende.d - 90
     where s.tenant_id = p_tenant and s.modus <> 'nur_analyse' and s.produkt is not null
  ),
  eindeutig as (
    select asin, min(produkt) as produkt from produkt_asins group by asin having count(*) = 1
  ),
  pw as (
    select e.produkt, r.zeitraum_von as von, max(r.zeitraum_bis) as bis, r.search_query as begriff,
           max(r.volume) as volumen, sum(r.kaufanteil) as kaufanteil, bool_and(r.duenn) as duenn
      from eindeutig e
      join public.sqp_rows r on r.tenant_id = p_tenant and r.asin = e.asin
                            and r.periode = 'WEEK' and r.marktplatz = p_marktplatz
     group by 1, 2, 4
  ),
  wochen as (select produkt, von, max(bis) as bis, count(*) as begriffe from pw group by 1, 2),
  n_wochen as (select produkt, count(*) as n, max(von) as letzte from wochen group by 1),
  kern as (
    select pw.produkt, pw.begriff
      from pw join n_wochen n using (produkt)
     group by pw.produkt, pw.begriff, n.n
    having count(*) = n.n
  ),
  kern_woche as (
    select pw.produkt, pw.von, sum(pw.volumen) as volumen,
           sum(pw.volumen * pw.kaufanteil) / nullif(sum(pw.volumen), 0) as kaufanteil
      from pw join kern k on k.produkt = pw.produkt and k.begriff = pw.begriff
     group by 1, 2
  ),
  top as (
    select produkt, begriff, volumen,
           row_number() over (partition by produkt order by volumen desc, begriff) as rang
      from pw join n_wochen n using (produkt)
     where pw.von = n.letzte
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'produkt', n.produkt,
    'asins', (select jsonb_agg(distinct r.asin) from eindeutig e
                join public.sqp_rows r on r.tenant_id = p_tenant and r.asin = e.asin
                                      and r.periode = 'WEEK' and r.marktplatz = p_marktplatz
               where e.produkt = n.produkt),
    'kern_begriffe', (select count(*) from kern k where k.produkt = n.produkt),
    'wochen', (select jsonb_agg(jsonb_build_object(
                        'von', w.von, 'bis', w.bis, 'begriffe', w.begriffe,
                        'kern_volumen', kw.volumen, 'kern_kaufanteil', round(kw.kaufanteil::numeric, 2))
                      order by w.von)
                 from wochen w
                 left join kern_woche kw on kw.produkt = w.produkt and kw.von = w.von
                where w.produkt = n.produkt),
    'begriffe', (select jsonb_agg(jsonb_build_object(
                          'begriff', t.begriff,
                          'kern', exists (select 1 from kern k where k.produkt = t.produkt and k.begriff = t.begriff),
                          'wochen', (select jsonb_agg(jsonb_build_object(
                                               'von', pw.von, 'volumen', pw.volumen,
                                               'kaufanteil', pw.kaufanteil, 'duenn', pw.duenn) order by pw.von)
                                       from pw where pw.produkt = t.produkt and pw.begriff = t.begriff))
                        order by t.rang)
                   from top t
                  where t.produkt = n.produkt and t.rang <= greatest(1, least(coalesce(p_top, 15), 50)))
  ) order by n.produkt), '[]'::jsonb)
    from n_wochen n;
$function$;

revoke all on function public.sqp_produkt_verlauf(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.sqp_produkt_verlauf(uuid, text, integer) to service_role;
notify pgrst, 'reload schema';

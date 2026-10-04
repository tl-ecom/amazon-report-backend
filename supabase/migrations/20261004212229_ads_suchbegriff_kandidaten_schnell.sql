-- ads_suchbegriff_kandidaten lief ueber die API ins Statement-Timeout.
--
-- Die erste Fassung pruefte je Kandidatenzeile mit drei korrelierten EXISTS
-- gegen alle Ziele des Kontos: rund 930 Zeilen x 9.500 Ziele x 3. Im SQL-Editor
-- faellt das nicht auf (kein Zeitlimit), ueber PostgREST gelten 8 Sekunden.
-- Gefunden am 04.10.2026 mit dem ersten echten Aufruf ueber
-- `tools/ads_gebote.py lesen` — der Bereich Ads-Kandidaten war bis dahin live
-- und kaputt.
--
-- Jetzt als Joins mit Gleichheits-Schluessel (Anzeigengruppe bzw. Kampagne):
-- jede Kandidatenzeile sieht nur noch die Ziele ihrer eigenen Gruppe oder
-- Kampagne. Ergebnis und Felder unveraendert.
create or replace function public.ads_suchbegriff_kandidaten(
  p_tenant uuid,
  p_von date,
  p_bis date,
  p_marktplatz text,
  p_min_klicks integer default 10
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with stand as (
    select max(gesehen_am) as s from public.ads_kampagnen
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  ziele as materialized (
    select z.art, z.campaign_id, z.ad_group_id, z.match_type, z.state,
           lower(z.text) as text_klein,
           -- ASIN eines Produkt-Targets, klein — damit sie per Gleichheit auf den
           -- Suchbegriff passt statt per Teilstring-Suche.
           lower(substring(z.text from '[Bb]0[A-Za-z0-9]{8}')) as asin_klein
      from public.ads_ziele z, stand
     where z.tenant_id = p_tenant and z.marktplatz = p_marktplatz
       and z.gesehen_am = stand.s and z.text is not null
  ),
  roh as (
    select campaign_id, ad_group_id, lower(suchbegriff) as sb,
           max(campaign_name) as campaign_name, max(ad_group_name) as ad_group_name,
           array_agg(distinct match_type) filter (where match_type is not null) as match_types,
           sum(impressions) as impressions, sum(clicks) as clicks,
           sum(spend_cents) as spend_cents, sum(sales_cents) as sales_cents, sum(orders) as orders
      from public.ads_suchbegriffe_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP'
       and datum between p_von and p_bis
     group by 1, 2, 3
  ),
  gruppen_asins as (
    select ad_group_id, array_agg(distinct asin) as asins
      from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
       and datum between p_von and p_bis and asin <> '' and impressions > 0
     group by 1
  ),
  kand as materialized (
    select * from roh where orders >= 1 or clicks >= greatest(coalesce(p_min_klicks, 10), 1)
  ),
  -- Schon ausgeschlossen: Negative der Gruppe oder der Kampagne, als Keyword
  -- (Exact, Phrase) oder als Produkt-Target.
  negativ as (
    select k.campaign_id, k.ad_group_id, k.sb
      from kand k join ziele z on z.ad_group_id = k.ad_group_id
     where z.state = 'ENABLED' and z.art = 'negativ_keyword'
       and ((z.match_type = 'NEGATIVE_EXACT' and z.text_klein = k.sb)
            or (z.match_type = 'NEGATIVE_PHRASE'
                and position(' ' || z.text_klein || ' ' in ' ' || k.sb || ' ') > 0))
    union
    select k.campaign_id, k.ad_group_id, k.sb
      from kand k join ziele z on z.campaign_id = k.campaign_id
     where z.state = 'ENABLED' and z.art = 'kampagne_negativ_keyword'
       and ((z.match_type = 'NEGATIVE_EXACT' and z.text_klein = k.sb)
            or (z.match_type = 'NEGATIVE_PHRASE'
                and position(' ' || z.text_klein || ' ' in ' ' || k.sb || ' ') > 0))
    union
    select k.campaign_id, k.ad_group_id, k.sb
      from kand k join ziele z on z.ad_group_id = k.ad_group_id and z.asin_klein = k.sb
     where z.state = 'ENABLED' and z.art = 'negativ_target'
    union
    select k.campaign_id, k.ad_group_id, k.sb
      from kand k join ziele z on z.campaign_id = k.campaign_id and z.asin_klein = k.sb
     where z.state = 'ENABLED' and z.art = 'kampagne_negativ_target'
  ),
  -- Der Begriff IST ein Ziel dieser Gruppe (Exact-Keyword oder ASIN-Target).
  -- Dann ist ein Negative die falsche Antwort: man prueft das Ziel selbst.
  ist_ziel as (
    select distinct k.campaign_id, k.ad_group_id, k.sb
      from kand k join ziele z on z.ad_group_id = k.ad_group_id
     where (z.art = 'keyword' and z.match_type = 'EXACT' and z.text_klein = k.sb)
        or (z.art = 'target' and z.asin_klein = k.sb)
  ),
  exact as (
    select z.text_klein,
           case when bool_or(z.state = 'ENABLED') then 'aktiv' else 'pausiert' end as zustand
      from ziele z
     where z.art = 'keyword' and z.match_type = 'EXACT'
     group by z.text_klein
  )
  select jsonb_build_object(
    'stand', (select s from stand),
    'konto', (select jsonb_build_object(
                'clicks', coalesce(sum(clicks), 0), 'orders', coalesce(sum(orders), 0),
                'spend_cents', coalesce(sum(spend_cents), 0), 'begriffe', count(distinct sb))
              from roh),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign_id', k.campaign_id, 'campaign_name', k.campaign_name,
        'ad_group_id', k.ad_group_id, 'ad_group_name', k.ad_group_name,
        'suchbegriff', k.sb, 'match_types', coalesce(to_jsonb(k.match_types), '[]'::jsonb),
        'impressions', k.impressions, 'clicks', k.clicks, 'spend_cents', k.spend_cents,
        'sales_cents', k.sales_cents, 'orders', k.orders,
        'asins', coalesce(to_jsonb(g.asins), '[]'::jsonb),
        'negativ_vorhanden', (n.sb is not null),
        'ist_ziel_der_gruppe', (i.sb is not null),
        'exact_im_konto', x.zustand
      ))
      from kand k
      left join gruppen_asins g using (ad_group_id)
      left join negativ n  on n.campaign_id = k.campaign_id and n.ad_group_id = k.ad_group_id and n.sb = k.sb
      left join ist_ziel i on i.campaign_id = k.campaign_id and i.ad_group_id = k.ad_group_id and i.sb = k.sb
      left join exact x    on x.text_klein = k.sb
    ), '[]'::jsonb)
  );
$function$;

notify pgrst, 'reload schema';

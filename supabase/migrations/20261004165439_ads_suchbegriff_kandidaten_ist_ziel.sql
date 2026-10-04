-- Suchbegriff-Kandidaten: wofuer wird Geld ausgegeben, das nichts bringt, und
-- was bringt Bestellungen, ohne ein eigenes Keyword zu haben.
--
-- Die Funktion liefert die ROHLAGE je (Kampagne, Anzeigengruppe, Suchbegriff)
-- und drei Fakten dazu, die sich nur in SQL guenstig bestimmen lassen:
--
--   negativ_vorhanden  der Begriff ist in dieser Gruppe oder Kampagne schon
--                      ausgeschlossen (Exact, Phrase oder als Produkt-Target)
--   exact_im_konto     es gibt irgendwo im Konto ein Exact-Keyword mit genau
--                      diesem Text: 'aktiv', 'pausiert' oder NULL
--   asins              welche ASINs die Anzeigengruppe im Zeitraum beworben hat
--
-- Die Einordnung als Negativ- oder Ernte-Kandidat passiert in TypeScript
-- (_shared/ads_kandidaten.ts) — dort ist sie testbar.
--
-- NUR SPONSORED PRODUCTS: der Struktur-Snapshot (ads_ziele) kennt keine
-- Sponsored-Brands-Ziele. Ohne ihn liesse sich nicht sagen, ob ein Begriff
-- schon ausgeschlossen ist, und die Liste wuerde Erledigtes vorschlagen.
--
-- NUR DER LETZTE SNAPSHOT: ads_ziele behaelt geloeschte Ziele mit altem Stempel.
-- Ein vor Wochen entferntes Negative darf hier nicht als vorhanden zaehlen.
--
-- jsonb statt Tabelle: PostgREST deckelt Tabellenantworten auf 1000 Zeilen,
-- Vaneja hat im 60-Tage-Fenster rund 1100 Kandidatenzeilen.
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
           lower(z.text) as text_klein, upper(z.text) as text_gross
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
  kand as (
    select * from roh where orders >= 1 or clicks >= greatest(coalesce(p_min_klicks, 10), 1)
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
        'negativ_vorhanden', exists (
          select 1 from ziele z
           where z.state = 'ENABLED'
             and (
               ( ((z.art = 'negativ_keyword' and z.ad_group_id = k.ad_group_id)
                  or (z.art = 'kampagne_negativ_keyword' and z.campaign_id = k.campaign_id))
                 and ((z.match_type = 'NEGATIVE_EXACT' and z.text_klein = k.sb)
                      or (z.match_type = 'NEGATIVE_PHRASE'
                          and position(' ' || z.text_klein || ' ' in ' ' || k.sb || ' ') > 0)) )
               or
               ( ((z.art = 'negativ_target' and z.ad_group_id = k.ad_group_id)
                  or (z.art = 'kampagne_negativ_target' and z.campaign_id = k.campaign_id))
                 and k.sb ~ '^b0[a-z0-9]{8}$'
                 and position(upper(k.sb) in z.text_gross) > 0 )
             )
        ),
        -- Der Begriff IST ein Ziel dieser Gruppe (Exact-Keyword oder ASIN-Target).
        -- Dann ist ein Negative die falsche Antwort: man prueft das Ziel selbst.
        'ist_ziel_der_gruppe', exists (
          select 1 from ziele z
           where z.ad_group_id = k.ad_group_id
             and ((z.art = 'keyword' and z.match_type = 'EXACT' and z.text_klein = k.sb)
                  or (z.art = 'target' and k.sb ~ '^b0[a-z0-9]{8}$'
                      and position(upper(k.sb) in z.text_gross) > 0))
        ),
        'exact_im_konto', (
          select case when count(*) = 0 then null
                      when bool_or(z.state = 'ENABLED') then 'aktiv'
                      else 'pausiert' end
            from ziele z
           where z.art = 'keyword' and z.match_type = 'EXACT' and z.text_klein = k.sb
        )
      ))
      from kand k left join gruppen_asins g using (ad_group_id)
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_suchbegriff_kandidaten(uuid, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.ads_suchbegriff_kandidaten(uuid, date, date, text, integer) to service_role;

notify pgrst, 'reload schema';

-- Zwei Auswertungen nach demselben Muster wie ads_keyword_wirkung:
--
-- 1. ads_negativ_wirkung — was hat ein angelegtes Negative abgeschnitten.
--    Je Negative der Suchbegriff IN SEINEM GELTUNGSBEREICH (Anzeigengruppe oder
--    Kampagne) davor und danach, und bei Exact-Negatives derselbe Begriff
--    ANDERSWO. "Davor" beantwortet die eigentliche Frage: waren das nur Kosten,
--    oder hingen Bestellungen daran. "Danach" im Geltungsbereich muesste null
--    sein — ist es das nicht, greift das Negative nicht.
--
--    Quellen wie bei den Keywords: Pulse-Protokoll (minutengenau, mit
--    Begruendung) und Struktur-Snapshot (ads_ziele.erstmals_gesehen, seit
--    04.10.2026, auch Negatives aus der Amazon-Konsole).
--
--    Fenster: gleich lang davor und danach, hoechstens 30 Tage, ohne den Tag
--    der Anlage.
--
--    Phrase-Negatives treffen jeden Suchbegriff, der die Phrase als Wortfolge
--    enthaelt. "Anderswo" gibt es fuer sie nicht — dafuer muesste "derselbe
--    Begriff" eindeutig sein.
--
-- 2. ads_kampagnen_starts — neu gestartete Kampagnen und was sie seit dem Start
--    gebracht haben, mit den ASINs, die sie bewerben (fuer die Marge).
create or replace function public.ads_negativ_wirkung(
  p_tenant uuid,
  p_marktplatz text,
  p_von date,
  p_bis date
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with kamp as (
    select campaign_id, name from public.ads_kampagnen
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  stand as (
    select max(datum) as letzter_tag from public.ads_suchbegriffe_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP'
  ),
  log_neg as (
    select l.campaign_id,
           coalesce(l.nachher ->> 'adGroupId', '') as ad_group_id,
           case when l.aktion = 'negative_target_anlegen' then 'asin' else 'keyword' end as typ,
           case when l.nachher ->> 'matchType' = 'NEGATIVE_PHRASE' then 'phrase' else 'exact' end as match,
           lower(coalesce(l.nachher ->> 'keywordText', l.nachher #>> '{expression,0,value}')) as begriff,
           l.created_at as am, 'pulse_log'::text as quelle, l.grund
      from public.ads_aenderungen_log l
      join kamp k on k.campaign_id = l.campaign_id
     where l.tenant_id = p_tenant and l.ergebnis = 'ok'
       and l.aktion in ('negative_anlegen', 'negative_target_anlegen')
  ),
  snap_neg as (
    select z.campaign_id,
           case when z.art like 'kampagne_%' then '' else z.ad_group_id end as ad_group_id,
           case when z.art like '%target' then 'asin' else 'keyword' end as typ,
           case when z.match_type = 'NEGATIVE_PHRASE' then 'phrase' else 'exact' end as match,
           case when z.art like '%target' then lower(substring(z.text from '[Bb]0[A-Za-z0-9]{8}')) else lower(z.text) end as begriff,
           z.erstmals_gesehen as am, 'snapshot'::text as quelle, null::text as grund
      from public.ads_ziele z
     where z.tenant_id = p_tenant and z.marktplatz = p_marktplatz
       and z.art like '%negativ%' and z.erstmals_gesehen is not null and z.text is not null
  ),
  neg as (
    select row_number() over () as id, n.*,
           (n.am at time zone 'Europe/Berlin')::date as d,
           greatest(0, least(30, (select letzter_tag from stand) - (n.am at time zone 'Europe/Berlin')::date)) as tage
      from (
        select * from log_neg where begriff is not null
        union all
        select s.* from snap_neg s
         where s.begriff is not null
           and not exists (select 1 from log_neg l
                            where l.begriff = s.begriff and l.campaign_id = s.campaign_id
                              and l.ad_group_id = s.ad_group_id)
      ) n
     where (n.am at time zone 'Europe/Berlin')::date between p_von and p_bis
  ),
  sb as materialized (
    select datum, campaign_id, ad_group_id, lower(suchbegriff) as sb,
           sum(clicks) as clicks, sum(spend_cents) as spend_cents,
           sum(sales_cents) as sales_cents, sum(orders) as orders
      from public.ads_suchbegriffe_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP'
       and datum >= p_von - 31
     group by 1, 2, 3, 4
  ),
  -- Der Begriff im Geltungsbereich des Negativs.
  bereich as (
    select n.id,
           coalesce(sum(s.clicks)      filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_clk,
           coalesce(sum(s.spend_cents) filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_spend,
           coalesce(sum(s.sales_cents) filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_sales,
           coalesce(sum(s.orders)      filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_ord,
           coalesce(sum(s.clicks)      filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_clk,
           coalesce(sum(s.spend_cents) filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_spend,
           coalesce(sum(s.sales_cents) filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_sales,
           coalesce(sum(s.orders)      filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_ord
      from neg n
      left join sb s
        on ((n.ad_group_id <> '' and s.ad_group_id = n.ad_group_id)
            or (n.ad_group_id = '' and s.campaign_id = n.campaign_id))
       and ((n.match = 'exact' and s.sb = n.begriff)
            or (n.match = 'phrase' and position(' ' || n.begriff || ' ' in ' ' || s.sb || ' ') > 0))
     group by n.id
  ),
  -- Derselbe Begriff ausserhalb des Geltungsbereichs (nur Exact).
  anderswo as (
    select n.id,
           coalesce(sum(s.clicks)      filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_clk,
           coalesce(sum(s.spend_cents) filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_spend,
           coalesce(sum(s.sales_cents) filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_sales,
           coalesce(sum(s.orders)      filter (where s.datum between n.d - n.tage and n.d - 1), 0) as v_ord,
           coalesce(sum(s.clicks)      filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_clk,
           coalesce(sum(s.spend_cents) filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_spend,
           coalesce(sum(s.sales_cents) filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_sales,
           coalesce(sum(s.orders)      filter (where s.datum between n.d + 1 and n.d + n.tage), 0) as n_ord
      from neg n
      join sb s on s.sb = n.begriff
       and not ((n.ad_group_id <> '' and s.ad_group_id = n.ad_group_id)
                or (n.ad_group_id = '' and s.campaign_id = n.campaign_id))
     where n.match = 'exact'
     group by n.id
  )
  select jsonb_build_object(
    'letzter_tag', (select letzter_tag from stand),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'begriff', n.begriff, 'typ', n.typ, 'match', n.match,
        'ebene', case when n.ad_group_id = '' then 'kampagne' else 'gruppe' end,
        'campaign_id', n.campaign_id, 'campaign_name', k.name,
        'ad_group_name', g.name,
        'am', n.am, 'quelle', n.quelle, 'grund', n.grund, 'tage', n.tage,
        'vorher', jsonb_build_object('clicks', b.v_clk, 'spend_cents', b.v_spend, 'sales_cents', b.v_sales, 'orders', b.v_ord),
        'nachher', jsonb_build_object('clicks', b.n_clk, 'spend_cents', b.n_spend, 'sales_cents', b.n_sales, 'orders', b.n_ord),
        'anderswo_vorher', case when n.match <> 'exact' then null else
          jsonb_build_object('clicks', coalesce(a.v_clk, 0), 'spend_cents', coalesce(a.v_spend, 0), 'sales_cents', coalesce(a.v_sales, 0), 'orders', coalesce(a.v_ord, 0)) end,
        'anderswo_nachher', case when n.match <> 'exact' then null else
          jsonb_build_object('clicks', coalesce(a.n_clk, 0), 'spend_cents', coalesce(a.n_spend, 0), 'sales_cents', coalesce(a.n_sales, 0), 'orders', coalesce(a.n_ord, 0)) end
      ) order by n.am desc)
      from neg n
      join bereich b on b.id = n.id
      left join anderswo a on a.id = n.id
      left join kamp k on k.campaign_id = n.campaign_id
      left join public.ads_anzeigengruppen g
        on g.tenant_id = p_tenant and g.marktplatz = p_marktplatz and g.ad_group_id = n.ad_group_id
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_negativ_wirkung(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.ads_negativ_wirkung(uuid, text, date, date) to service_role;

create or replace function public.ads_kampagnen_starts(
  p_tenant uuid,
  p_marktplatz text,
  p_von date,
  p_bis date
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with stand as (
    select max(datum) as letzter_tag from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz and ad_product = 'SP'
  ),
  k as (
    select campaign_id, name, state, targeting_typ, budget_cents, start_datum
      from public.ads_kampagnen
     where tenant_id = p_tenant and marktplatz = p_marktplatz
       and start_datum between p_von and p_bis
       -- Nur der letzte Snapshot: was archiviert wurde, steht dort nicht mehr.
       and gesehen_am = (select max(gesehen_am) from public.ads_kampagnen
                          where tenant_id = p_tenant and marktplatz = p_marktplatz)
  )
  select jsonb_build_object(
    'letzter_tag', (select letzter_tag from stand),
    'zeilen', coalesce((
      select jsonb_agg(jsonb_build_object(
        'campaign_id', k.campaign_id, 'name', k.name, 'state', k.state,
        'targeting_typ', k.targeting_typ, 'budget_cents', k.budget_cents, 'start_datum', k.start_datum,
        'tage', greatest(0, (select letzter_tag from stand) - k.start_datum + 1),
        'clicks', coalesce(s.clicks, 0), 'spend_cents', coalesce(s.spend_cents, 0),
        'sales_cents', coalesce(s.sales_cents, 0), 'orders', coalesce(s.orders, 0),
        'asins', coalesce(to_jsonb(s.asins), '[]'::jsonb)
      ) order by k.start_datum desc)
      from k
      left join lateral (
        select sum(a.clicks) as clicks, sum(a.spend_cents) as spend_cents,
               sum(a.sales_cents) as sales_cents, sum(a.orders) as orders,
               array_agg(distinct a.asin) filter (where a.asin <> '') as asins
          from public.ads_daily a
         where a.tenant_id = p_tenant and a.marktplatz = p_marktplatz and a.ad_product = 'SP'
           and a.campaign_id = k.campaign_id and a.datum >= k.start_datum
      ) s on true
    ), '[]'::jsonb)
  );
$function$;

revoke all on function public.ads_kampagnen_starts(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.ads_kampagnen_starts(uuid, text, date, date) to service_role;

notify pgrst, 'reload schema';

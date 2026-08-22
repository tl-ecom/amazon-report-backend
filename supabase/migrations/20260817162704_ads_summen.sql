-- ads_summen — Rohsummen aus ads_daily fuer einen frei waehlbaren Zeitraum.
--
-- Bewusst NUR Summen, keine Kennzahlen: ACOS, ROAS, CTR, CVR und CPC entstehen
-- ausschliesslich in _shared/ads.ts (kennzahlenAusSummen), damit es fuer beide
-- Wege — Report-Overview und Zeitraum-Verlauf — genau eine Formel gibt.
--
-- Warum ueberhaupt in SQL: Vaneja hat nach 90 Tagen rund 13.000 Zeilen in
-- ads_daily. Die alle in die Edge Function zu laden waere dieselbe Schuld, die
-- die Architekturdoku bei der bestehenden Range-Aggregation schon benennt.
-- So gehen ein paar hundert Summenzeilen statt Zehntausender Einzelzeilen.
--
-- Alle vier Ebenen in EINEM Ergebnis, unterschieden durch `ebene` — ein
-- Rundtrip statt vier.

create or replace function public.ads_summen(p_tenant uuid, p_von date, p_bis date)
returns table (
  ebene       text,
  schluessel  text,
  bezeichnung text,
  impressions bigint,
  clicks      bigint,
  spend_cents bigint,
  sales_cents bigint,
  orders      bigint,
  einheiten   bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with basis as (
    select *
    from public.ads_daily
    where tenant_id = p_tenant
      and datum between p_von and p_bis
  )
  select 'gesamt'::text, null::text, null::text,
         coalesce(sum(impressions),0)::bigint, coalesce(sum(clicks),0)::bigint,
         coalesce(sum(spend_cents),0)::bigint, coalesce(sum(sales_cents),0)::bigint,
         coalesce(sum(orders),0)::bigint, coalesce(sum(einheiten),0)::bigint
  from basis

  union all
  select 'tag', datum::text, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by datum

  union all
  -- max(campaign_name): Amazon laesst den Namen gelegentlich leer, ein
  -- nicht-leerer Treffer im Zeitraum gewinnt.
  select 'kampagne', campaign_id, nullif(max(coalesce(campaign_name,'')),''),
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by campaign_id

  union all
  select 'asin', asin, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis where asin <> '' group by asin
$function$;

comment on function public.ads_summen(uuid, date, date) is
  'Rohsummen aus ads_daily je Gesamt/Tag/Kampagne/ASIN fuer einen Zeitraum. Liefert bewusst keine Kennzahlen — ACOS & Co. rechnet _shared/ads.ts, damit es nur eine Formel gibt.';

revoke all on function public.ads_summen(uuid, date, date) from public;
grant execute on function public.ads_summen(uuid, date, date) to service_role;

notify pgrst, 'reload schema';;

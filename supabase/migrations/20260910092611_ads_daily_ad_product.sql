-- ads_daily kannte nur Sponsored Products.
--
-- Aufgefallen beim Sellerboard-Abgleich: Pulse wies fuer Vanejas August
-- 9.494 € Werbekosten aus, Sellerboard 11.586 €. Die Luecke von 18 % sind
-- Sponsored Brands (1.313 €), Brands Video (377 €) und Display (30 €) — sie
-- wurden nie geholt. Das verzerrt nicht nur die Werbekachel, sondern TACOS,
-- ACOS, den Break-even und jede Ertragsrechnung nach Werbung.
--
-- Der Schluessel bekommt deshalb den Anzeigentyp. Ohne ihn wuerde eine
-- SB-Kampagne eine SP-Zeile ueberschreiben, sobald beide am selben Tag
-- dieselbe Kampagnen-ID haetten — und die Zahlen waeren still falsch statt
-- offensichtlich falsch.
--
-- Bestehende Zeilen sind ausnahmslos Sponsored Products; der Default 'SP'
-- bildet das korrekt ab, ohne dass etwas nachgetragen werden muesste.
alter table public.ads_daily
  add column if not exists ad_product text not null default 'SP';

alter table public.ads_daily drop constraint if exists ads_daily_pkey;
alter table public.ads_daily
  add constraint ads_daily_pkey
  primary key (tenant_id, ad_product, datum, campaign_id, ad_group_id, asin, sku);

comment on column public.ads_daily.ad_product is
  'SP | SB | SD. Sponsored Brands laufen ohne ASIN (asin = ''''), weil Amazon fuer sie keine Produktebene liefert.';

-- Die ASIN-Ebene darf Sponsored Brands nicht als Produkt mit leerer ASIN
-- ausweisen. Sie werden dort ausgelassen und stattdessen als eigene Ebene
-- gemeldet, damit die Luecke sichtbar bleibt statt unterzugehen.
create or replace function public.ads_summen(p_tenant uuid, p_von date, p_bis date)
returns table(
  ebene text, schluessel text, bezeichnung text,
  impressions bigint, clicks bigint, spend_cents bigint,
  sales_cents bigint, orders bigint, einheiten bigint
)
language sql stable security definer set search_path to 'public'
as $function$
  with basis as (
    select * from public.ads_daily
    where tenant_id = p_tenant and datum between p_von and p_bis
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
  select 'kampagne', campaign_id, nullif(max(coalesce(campaign_name,'')),''),
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by campaign_id

  union all
  -- Nur Zeilen MIT ASIN. Sponsored Brands haben keine; sie hier mitzuzaehlen
  -- ergaebe ein Produkt namens "" mit vierstelligen Kosten.
  select 'asin', asin, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis where coalesce(asin,'') <> '' group by asin

  union all
  -- Neue Ebene: je Anzeigentyp. Macht sichtbar, wie viel auf SB/SD entfaellt
  -- und wie viel davon keiner ASIN zugeordnet werden kann.
  select 'ad_product', ad_product, null::text,
         sum(impressions)::bigint, sum(clicks)::bigint,
         sum(spend_cents)::bigint, sum(sales_cents)::bigint,
         sum(orders)::bigint, sum(einheiten)::bigint
  from basis group by ad_product

  union all
  select 'ohne_asin', null::text, null::text,
         coalesce(sum(impressions),0)::bigint, coalesce(sum(clicks),0)::bigint,
         coalesce(sum(spend_cents),0)::bigint, coalesce(sum(sales_cents),0)::bigint,
         coalesce(sum(orders),0)::bigint, coalesce(sum(einheiten),0)::bigint
  from basis where coalesce(asin,'') = ''
$function$;

revoke all on function public.ads_summen(uuid, date, date) from public, anon, authenticated;
grant execute on function public.ads_summen(uuid, date, date) to service_role;

notify pgrst, 'reload schema';;

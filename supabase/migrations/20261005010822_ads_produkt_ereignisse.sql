-- Was ist an welchem Tag mit einem verwalteten Produkt passiert: Preis,
-- Listing-Status, Versandart (change_events), Tage ohne verkaufsfaehigen
-- FBA-Bestand, und was ueber Pulse am Werbekonto geaendert wurde. Fuer die
-- Markierungen im Verlauf je Produkt. Gleiche Zuordnung wie ads_produkt_lage.
create or replace function public.ads_produkt_ereignisse(
  p_tenant uuid, p_marktplatz text, p_tage integer default 42
)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with t as (select greatest(7, least(coalesce(p_tage, 42), 180)) as n),
  ende as (
    select max(datum) as d from public.ads_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  von as (select ende.d - (t.n - 1) as d from ende cross join t),
  gesteuert as (
    select campaign_id, produkt from public.ads_steuerung
     where tenant_id = p_tenant and modus <> 'nur_analyse' and produkt is not null
  ),
  produkt_asins as (
    select distinct s.produkt, a.asin
      from gesteuert s cross join ende
      join public.ads_daily a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                             and a.marktplatz = p_marktplatz and a.asin <> ''
                             and a.datum > ende.d - 90
  ),
  eindeutig as (
    select asin, min(produkt) as produkt from produkt_asins group by asin having count(*) = 1
  ),
  namen as (
    select distinct on (campaign_id) campaign_id, name from public.ads_kampagnen
     where tenant_id = p_tenant order by campaign_id, gesehen_am desc
  ),
  listing as (
    select e.produkt, coalesce(c.effective_at, (c.detected_at at time zone 'Europe/Berlin')::date) as datum,
           case c.event_type when 'preis_geaendert' then 'preis' when 'listing_deaktiviert' then 'listing_aus'
                             when 'listing_aktiviert' then 'listing_an' else 'angebot' end as art,
           case c.event_type
             when 'preis_geaendert' then format('Preis %s → %s EUR (%s)', c.previous_value, c.new_value, c.asin)
             when 'listing_deaktiviert' then format('Listing inaktiv (%s)', c.asin)
             when 'listing_aktiviert' then format('Listing wieder aktiv (%s)', c.asin)
             else format('%s: %s → %s (%s)', c.event_type, c.previous_value, c.new_value, c.asin) end as text,
           1 as anzahl
      from eindeutig e
      join public.change_events c on c.tenant_id = p_tenant and c.asin = e.asin
     where c.event_category in ('angebot', 'listing')
  ),
  -- Tage, an denen eine ASIN am Tagesende keinen verkaufsfaehigen FBA-Bestand hatte.
  bestand as (
    select e.produkt, f.datum, 'ohne_bestand' as art,
           format('Kein verkaufsfähiger FBA-Bestand am Tagesende (%s)', f.asin) as text, 1 as anzahl
      from eindeutig e
      join public.fba_bestand_verlauf f on f.tenant_id = p_tenant and f.asin = e.asin and f.disposition = 'SELLABLE'
     group by e.produkt, f.datum, f.asin
    having sum(f.end_menge) <= 0
  ),
  kampagne as (
    select s.produkt, (l.created_at at time zone 'Europe/Berlin')::date as datum, 'werbung' as art,
           case
             when l.aktion in ('budget_setzen', 'sb_budget_setzen')
               then format('Budget %s → %s EUR: %s', l.vorher ->> 'budget', l.nachher ->> 'budget', coalesce(n.name, l.campaign_id))
             when l.aktion in ('kampagne_zustand', 'sb_kampagne_zustand')
               then format('Kampagne %s: %s', case l.nachher ->> 'state' when 'PAUSED' then 'pausiert' else 'aktiviert' end, coalesce(n.name, l.campaign_id))
             else format('Platzierungs-Aufschlag geändert: %s', coalesce(n.name, l.campaign_id)) end as text,
           1 as anzahl
      from gesteuert s
      join public.ads_aenderungen_log l on l.tenant_id = p_tenant and l.campaign_id = s.campaign_id
                                       and l.ergebnis = 'ok'
                                       and l.aktion in ('budget_setzen', 'sb_budget_setzen', 'kampagne_zustand', 'sb_kampagne_zustand', 'platzierung_setzen')
      left join namen n on n.campaign_id = l.campaign_id
  ),
  -- Kleinteiliges je Tag zusammengezaehlt: 40 Negatives sind eine Zeile, nicht 40.
  menge as (
    select s.produkt, (l.created_at at time zone 'Europe/Berlin')::date as datum, 'werbung' as art,
           case when l.aktion like 'keyword%' then 'Keywords angelegt' else 'Negatives angelegt' end as text,
           count(*)::int as anzahl
      from gesteuert s
      join public.ads_aenderungen_log l on l.tenant_id = p_tenant and l.campaign_id = s.campaign_id
                                       and l.ergebnis = 'ok'
                                       and l.aktion in ('keyword_anlegen', 'negative_anlegen', 'negative_target_anlegen', 'sb_negatives_anlegen')
     group by 1, 2, 4
    union all
    select s.produkt, (g.created_at at time zone 'Europe/Berlin')::date, 'werbung', 'Gebote über Pulse geändert', count(*)::int
      from gesteuert s
      join public.ads_gebote_log g on g.tenant_id = p_tenant and g.campaign_id = s.campaign_id and g.ergebnis = 'ok'
     group by 1, 2
  ),
  alle as (
    select * from listing union all select * from bestand
    union all select * from kampagne union all select * from menge
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'produkt', a.produkt, 'datum', a.datum, 'art', a.art, 'text', a.text, 'anzahl', a.anzahl)
           order by a.produkt, a.datum, a.art), '[]'::jsonb)
    from alle a cross join von cross join ende
   where a.datum >= von.d and a.datum <= ende.d + 3;
$function$;

revoke all on function public.ads_produkt_ereignisse(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.ads_produkt_ereignisse(uuid, text, integer) to service_role;
notify pgrst, 'reload schema';

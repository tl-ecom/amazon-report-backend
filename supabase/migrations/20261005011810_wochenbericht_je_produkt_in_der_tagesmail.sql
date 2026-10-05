-- Montags steht in der Tagesmail je verwaltetem Produkt eine Zeile: die
-- letzten 7 Tage mit Ads-Daten gegen die 7 davor, dazu was in der Woche am
-- Angebot passiert ist. Liest ads_produkt_lage und ads_produkt_ereignisse —
-- dieselben Zahlen wie im Bereich Ads-Budget.
--
-- Die bisherige ads_hinweise() heisst jetzt ads_hinweise_begriffe(); die neue
-- ads_hinweise() haengt den Wochenbericht an. So bleibt internal.cron_sync_wache
-- unveraendert.
create or replace function public.produkt_wochenbericht(p_immer boolean default false)
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  with mandanten as (
    select ac.tenant_id, t.name, public.ads_haupt_marktplatz(ac.tenant_id) as marktplatz
      from public.auth_contexts ac
      join public.tenants t on t.id = ac.tenant_id
     where ac.source = 'ads' and ac.status = 'connected' and t.status = 'active'
       and not t.wache_stumm
       and exists (select 1 from public.ads_steuerung s where s.tenant_id = ac.tenant_id)
       -- Nur montags (deutsche Zeit); p_immer zum Ansehen an anderen Tagen.
       and (p_immer or extract(isodow from now() at time zone 'Europe/Berlin') = 1)
  ),
  lage as (
    select m.tenant_id, m.name, m.marktplatz, public.ads_produkt_lage(m.tenant_id, m.marktplatz, 7) as l
      from mandanten m where m.marktplatz is not null
  ),
  werbung as (
    select g.tenant_id, z ->> 'produkt' as produkt, z ->> 'fenster' as fenster,
           sum((z ->> 'spend_cents')::numeric) / 100 as kosten, sum((z ->> 'sales_cents')::numeric) / 100 as umsatz
      from lage g, jsonb_array_elements(g.l -> 'zeilen') z group by 1, 2, 3
  ),
  gesamt as (
    select g.tenant_id, z ->> 'produkt' as produkt, z ->> 'fenster' as fenster,
           (z ->> 'umsatz_cents')::numeric / 100 as umsatz
      from lage g, jsonb_array_elements(g.l -> 'gesamtumsatz') z
  ),
  ereignisse as (
    select g.tenant_id, e ->> 'produkt' as produkt,
           string_agg(format('%s %s', to_char((e ->> 'datum')::date, 'DD.MM.'), e ->> 'text'), '; ' order by e ->> 'datum') as text
      from lage g,
           jsonb_array_elements(public.ads_produkt_ereignisse(g.tenant_id, g.marktplatz, 7)) e
     where e ->> 'art' <> 'werbung'
     group by 1, 2
  ),
  f as (select to_char(1, 'FM9') as dummy)
  select g.name, 'Woche ' || a.produkt,
         format('7 Tage bis %s: Umsatz gesamt %s EUR (davor %s), Werbekosten %s EUR (davor %s), Werbeumsatz %s EUR (davor %s), TACoS %s (davor %s), ACoS %s (davor %s).%s',
                to_char((g.l ->> 'letzter_tag')::date, 'DD.MM.'),
                coalesce(to_char(ga.umsatz, 'FM999990'), 'unbekannt'), coalesce(to_char(gd.umsatz, 'FM999990'), 'unbekannt'),
                to_char(a.kosten, 'FM999990'), coalesce(to_char(d.kosten, 'FM999990'), '0'),
                to_char(a.umsatz, 'FM999990'), coalesce(to_char(d.umsatz, 'FM999990'), '0'),
                coalesce(to_char(100 * a.kosten / nullif(ga.umsatz, 0), 'FM990D0') || ' %', 'unbekannt'),
                coalesce(to_char(100 * d.kosten / nullif(gd.umsatz, 0), 'FM990D0') || ' %', 'unbekannt'),
                coalesce(to_char(100 * a.kosten / nullif(a.umsatz, 0), 'FM990D0') || ' %', 'unbekannt'),
                coalesce(to_char(100 * d.kosten / nullif(d.umsatz, 0), 'FM990D0') || ' %', 'unbekannt'),
                coalesce(' In der Woche: ' || e.text || '.', ''))
    from lage g
    join werbung a on a.tenant_id = g.tenant_id and a.fenster = 'aktuell'
    left join werbung d on d.tenant_id = g.tenant_id and d.produkt = a.produkt and d.fenster = 'davor'
    left join gesamt ga on ga.tenant_id = g.tenant_id and ga.produkt = a.produkt and ga.fenster = 'aktuell'
    left join gesamt gd on gd.tenant_id = g.tenant_id and gd.produkt = a.produkt and gd.fenster = 'davor'
    left join ereignisse e on e.tenant_id = g.tenant_id and e.produkt = a.produkt
   order by a.kosten desc
$function$;

revoke all on function public.produkt_wochenbericht(boolean) from public, anon, authenticated;
grant execute on function public.produkt_wochenbericht(boolean) to service_role;

alter function public.ads_hinweise() rename to ads_hinweise_begriffe;

create function public.ads_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  select * from public.ads_hinweise_begriffe()
  union all
  select * from public.produkt_wochenbericht()
$function$;

revoke all on function public.ads_hinweise() from public, anon, authenticated;
grant execute on function public.ads_hinweise() to service_role;

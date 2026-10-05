-- Tagesmail: je verwaltetem Produkt eine Zeile, wenn am VORTAG (deutsche
-- Zeit) Kampagnen ihr Tagesbudget ausgeschoepft haben — mit der Uhrzeit, ab
-- der nichts mehr lief. Liest ads_budget_tage, dieselbe Quelle wie der
-- Bereich Ads-Budget. Nur Kampagnen, die in ads_steuerung als h10 oder pulse
-- stehen: das Budget bleibt auch bei Helium-10-Kampagnen Sache von Pulse.
-- Nur Sponsored Products (mehr misst sync-ads-budget nicht).
create or replace function public.budget_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  with gestern as (select ((now() at time zone 'Europe/Berlin')::date - 1) as d),
  mandanten as (
    select ac.tenant_id, t.name, public.ads_haupt_marktplatz(ac.tenant_id) as marktplatz
      from public.auth_contexts ac
      join public.tenants t on t.id = ac.tenant_id
     where ac.source = 'ads' and ac.status = 'connected' and t.status = 'active'
       and not t.wache_stumm
       and exists (select 1 from public.ads_steuerung s where s.tenant_id = ac.tenant_id)
  ),
  tage as (
    select m.tenant_id, m.name, z
      from mandanten m cross join gestern g,
           jsonb_array_elements(public.ads_budget_tage(m.tenant_id, m.marktplatz, g.d, g.d) -> 'zeilen') z
     where m.marktplatz is not null
       and (z ->> 'tag')::date = g.d and (z ->> 'n_voll')::int > 0
  )
  select t.name, 'Budget leer ' || s.produkt,
         format('Am %s liefen %s Kampagne(n) aus dem Tagesbudget: %s.',
                to_char((select d from gestern), 'DD.MM.'), count(*),
                string_agg(format('%s (Budget %s EUR, leer ab %s Uhr, %s h ohne Auslieferung)',
                                  coalesce(t.z ->> 'campaign_name', t.z ->> 'campaign_id'),
                                  coalesce(to_char((t.z ->> 'budget_cents')::numeric / 100, 'FM999990'), '?'),
                                  coalesce(to_char((t.z ->> 'letzte_bewegung')::timestamptz at time zone 'Europe/Berlin', 'HH24:MI'), '?'),
                                  coalesce(to_char(greatest(0, extract(epoch from ((t.z ->> 'tagesende')::timestamptz
                                             - (t.z ->> 'letzte_bewegung')::timestamptz)) / 3600), 'FM990D0'), '?')),
                            '; ' order by (t.z ->> 'letzte_bewegung')))
    from tage t
    join public.ads_steuerung s on s.tenant_id = t.tenant_id and s.campaign_id = t.z ->> 'campaign_id'
   where s.modus <> 'nur_analyse' and s.produkt is not null
   group by t.name, s.produkt
$function$;

revoke all on function public.budget_hinweise() from public, anon, authenticated;
grant execute on function public.budget_hinweise() to service_role;

create or replace function public.ads_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  select * from public.budget_hinweise()
  union all
  select * from public.ads_hinweise_begriffe()
  union all
  select * from public.produkt_wochenbericht()
$function$;

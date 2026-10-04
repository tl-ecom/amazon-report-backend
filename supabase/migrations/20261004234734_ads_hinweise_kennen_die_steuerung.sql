-- Die Tagesmail kennt jetzt ads_steuerung: Hinweise zu Kampagnen, die nur
-- ausgewertet werden, entfallen. Setzt Helium 10 die Gebote, sagt der Hinweis
-- das dazu — ein zu niedriges Gebot behebt man dann dort, nicht ueber Pulse.
create or replace function public.ads_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  with laender as (
    select ac.tenant_id, t.name,
           coalesce(m.mp, public.ads_haupt_marktplatz(ac.tenant_id)) as marktplatz
      from public.auth_contexts ac
      join public.tenants t on t.id = ac.tenant_id
      left join lateral (select mp from internal.ads_aktive_marktplaetze(ac.tenant_id) mp) m on true
     where ac.source = 'ads' and ac.status = 'connected' and t.status = 'active'
       and not t.wache_stumm
  ),
  ziele as (
    select l.name, l.marktplatz, r,
           (r ->> 'gebot_cents')::numeric / 100 as gebot,
           (r #>> '{vorher,spend_cents}')::numeric / 100
             / nullif((r #>> '{vorher,clicks}')::numeric, 0) as cpc_vorher,
           -- Mandant mit Einstufung: nicht gelistet = nur_analyse. Ohne Einstufung: keine Regel.
           case when exists (select 1 from public.ads_steuerung x where x.tenant_id = l.tenant_id)
                then coalesce((select s.modus from public.ads_steuerung s
                                where s.tenant_id = l.tenant_id and s.campaign_id = r ->> 'campaign_id'), 'nur_analyse')
                else 'pulse' end as modus
      from laender l,
           jsonb_array_elements(
             public.ads_keyword_wirkung(l.tenant_id, l.marktplatz, current_date - 40, current_date) -> 'zeilen'
           ) r
     where l.marktplatz is not null
  )
  select z.name, 'Begriff eingebrochen',
         format('%s (%s, angelegt am %s in %s): davor %s Klicks und %s Bestellungen, seither %s Klicks und %s Bestellungen ueber alle Ziele. %s%s',
                z.r ->> 'text',
                coalesce(z.r ->> 'match_type', z.r ->> 'art'),
                to_char((z.r ->> 'angelegt')::timestamptz, 'DD.MM.'),
                coalesce(z.r ->> 'campaign_name', 'unbekannter Kampagne'),
                z.r #>> '{vorher,clicks}', z.r #>> '{vorher,orders}',
                (z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int,
                (z.r #>> '{eigen,orders}')::int + (z.r #>> '{anderswo,orders}')::int,
                case
                  when z.gebot is not null and z.cpc_vorher is not null and z.gebot < z.cpc_vorher then
                    format('Das Gebot von %s EUR liegt unter dem bisherigen Klickpreis von %s EUR — das neue Ziel gewinnt die Auktion vermutlich nicht.',
                           to_char(z.gebot, 'FM990.00'), to_char(z.cpc_vorher, 'FM990.00'))
                  else 'Das Gebot liegt nicht unter dem bisherigen Klickpreis — in der Quelle negiert, pausiert oder Budget erschoepft?'
                end,
                case when z.modus = 'h10'
                     then ' Die Gebote dieser Kampagne setzt Helium 10: dort Ziel-ACoS und Hoechstgebot pruefen, nicht ueber Pulse aendern.'
                     else '' end)
    from ziele z
   where z.modus <> 'nur_analyse'
     and (z.r ->> 'tage')::int between 7 and 9
     and z.r -> 'vorher' is not null and z.r -> 'vorher' <> 'null'::jsonb
     and (z.r #>> '{vorher,clicks}')::int >= 5
     and ((z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int) * 4
         < (z.r #>> '{vorher,clicks}')::int
$function$;

-- Der Hinweis "Begriff eingebrochen" nennt jetzt die naheliegendste Ursache:
-- das Gebot des neuen Ziels gegen den Klickpreis, den der Begriff davor ueber
-- andere Ziele kostete. Vanejas "kratzbrett l form": 1,21 EUR je Klick ueber
-- Broad, Exact-Gebot 0,71 EUR. Vorher stand in der Mail nur die Frage
-- "Gebot zu niedrig oder in der Quelle negiert?" — die Antwort lag in den Daten.
--
-- Dieselbe Regel steht in _shared/ads_wirkung.ts (gebot_unter_klickpreis).
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
             / nullif((r #>> '{vorher,clicks}')::numeric, 0) as cpc_vorher
      from laender l,
           jsonb_array_elements(
             public.ads_keyword_wirkung(l.tenant_id, l.marktplatz, current_date - 40, current_date) -> 'zeilen'
           ) r
     where l.marktplatz is not null
  )
  select z.name, 'Begriff eingebrochen',
         format('%s (%s, angelegt am %s in %s): davor %s Klicks und %s Bestellungen, seither %s Klicks und %s Bestellungen ueber alle Ziele. %s',
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
                end)
    from ziele z
   where (z.r ->> 'tage')::int between 7 and 9
     and z.r -> 'vorher' is not null and z.r -> 'vorher' <> 'null'::jsonb
     and (z.r #>> '{vorher,clicks}')::int >= 5
     and ((z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int) * 4
         < (z.r #>> '{vorher,clicks}')::int
$function$;

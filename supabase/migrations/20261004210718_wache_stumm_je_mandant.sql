-- Ein Mandant kann aus der taeglichen Mail herausgenommen werden, ohne dass
-- seine Daten oder Laeufe angefasst werden. Anlass: e-One verkauft nicht mehr;
-- Meldungen zu einem Konto, um das sich niemand kuemmert, sind Laerm und
-- verdecken die Meldungen, die zaehlen.
--
-- Bewusst ein Schalter am Mandanten und kein Name in der Funktion: der naechste
-- Fall braucht dann ein UPDATE und keine Migration.
--
-- NUR DIE MAIL. Die Syncs laufen weiter (tenants.status bleibt 'active'). Wer
-- einen Mandanten ganz stilllegen will, setzt den Status — das ist eine andere
-- Entscheidung.
alter table public.tenants add column if not exists wache_stumm boolean not null default false;

comment on column public.tenants.wache_stumm is
  'true = keine Meldungen zu diesem Mandanten in der taeglichen Wache-Mail (Sync-Stoerungen und Ads-Hinweise). Die Syncs selbst laufen weiter.';

-- e-One
update public.tenants set wache_stumm = true where id = '931be15d-a463-4029-b7af-d796e790ed3c';

create or replace function public.sync_stoerungen(p_max_alter interval default '36:00:00'::interval)
returns table(mandant text, quelle text, art text, detail text)
language sql stable security definer set search_path to 'public'
as $function$
  select s.* from (
    select * from public.sync_stoerungen_basis(p_max_alter)

    union all

    -- 7. Ein Bericht, der regelmaessig lief, ist verstummt.
    select x.name, x.source, 'Bericht verstummt',
           string_agg(x.report_type, ', ' order by x.report_type)
             || ' — zuletzt erfolgreich am ' || to_char(min(x.zuletzt), 'DD.MM.')
    from (
      select t.name, ac.source, rj.report_type,
             count(*) filter (where rj.completed_at > now() - interval '14 days'
                                and rj.completed_at <= now() - p_max_alter) as davor,
             max(rj.completed_at) as zuletzt
        from public.auth_contexts ac
        join public.tenants t on t.id = ac.tenant_id
        join public.report_jobs rj
          on rj.tenant_id = ac.tenant_id and rj.source = ac.source and rj.status = 'DONE'
       where ac.status = 'connected' and t.status = 'active'
       group by t.name, ac.source, rj.report_type
    ) x
    where x.davor >= 5 and x.zuletzt < now() - p_max_alter
    group by x.name, x.source
  ) s
  -- Stummgeschaltete Mandanten: an EINER Stelle fuer alle sieben Pruefungen.
  where not exists (
    select 1 from public.tenants t where t.name = s.mandant and t.wache_stumm
  )
$function$;

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
    select l.name, l.marktplatz, r
      from laender l,
           jsonb_array_elements(
             public.ads_keyword_wirkung(l.tenant_id, l.marktplatz, current_date - 40, current_date) -> 'zeilen'
           ) r
     where l.marktplatz is not null
  )
  select z.name, 'Begriff eingebrochen',
         format('%s (%s, angelegt am %s in %s): davor %s Klicks und %s Bestellungen, seither %s Klicks und %s Bestellungen ueber alle Ziele. Gebot zu niedrig oder in der Quelle negiert?',
                z.r ->> 'text',
                coalesce(z.r ->> 'match_type', z.r ->> 'art'),
                to_char((z.r ->> 'angelegt')::timestamptz, 'DD.MM.'),
                coalesce(z.r ->> 'campaign_name', 'unbekannter Kampagne'),
                z.r #>> '{vorher,clicks}', z.r #>> '{vorher,orders}',
                (z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int,
                (z.r #>> '{eigen,orders}')::int + (z.r #>> '{anderswo,orders}')::int)
    from ziele z
   where (z.r ->> 'tage')::int between 7 and 9
     and z.r -> 'vorher' is not null and z.r -> 'vorher' <> 'null'::jsonb
     and (z.r #>> '{vorher,clicks}')::int >= 5
     and ((z.r #>> '{eigen,clicks}')::int + (z.r #>> '{anderswo,clicks}')::int) * 4
         < (z.r #>> '{vorher,clicks}')::int
$function$;

notify pgrst, 'reload schema';

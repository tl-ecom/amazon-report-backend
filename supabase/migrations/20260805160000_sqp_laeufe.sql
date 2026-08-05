-- Status je SQP-Abruf festhalten.
--
-- Bisher war ein Abruf fuer die App unsichtbar: sync-sqp laeuft ueber pg_net,
-- seine Antwort landet nirgends. Das Frontend sah nur "es kommen keine Zeilen"
-- und musste ~3 Minuten blind pollen, bevor es aufgab — auch dann, wenn Amazon
-- schon nach 40 Sekunden FATAL gemeldet hatte.
--
-- Eine Zeile je (tenant, asin, periode, zeitraum_von): der Anstoss setzt sie auf
-- 'laeuft', sync-sqp schreibt am Ende das Ergebnis. Damit weiss die Oberflaeche,
-- ob noch gewartet wird, ob es Daten gibt oder woran es lag.

create table if not exists public.sqp_laeufe (
  tenant_id     uuid not null,
  asin          text not null,
  periode       text not null,
  zeitraum_von  date not null,
  zeitraum_bis  date not null,
  -- laeuft = angestossen, noch kein Ergebnis
  -- fertig = Zeilen gespeichert
  -- leer   = Amazon lieferte den Report, aber ohne Suchanfragen
  -- fehler = Amazon hat abgelehnt oder es hat zu lange gedauert
  status        text not null check (status in ('laeuft', 'fertig', 'leer', 'fehler')),
  zeilen        integer,
  meldung       text,
  report_id     text,
  gestartet     timestamptz not null default now(),
  beendet       timestamptz,
  primary key (tenant_id, asin, periode, zeitraum_von)
);

alter table public.sqp_laeufe enable row level security;
-- Bewusst ohne Policy: wie sqp_rows kommt nur die service_role heran, und die
-- geht an RLS vorbei. Das Frontend liest ueber die api-Function, nie direkt.

-- Anstoss setzt den Lauf auf 'laeuft', bevor der Aufruf rausgeht. So sieht die
-- App den laufenden Abruf auch dann, wenn die Edge Function erst Sekunden
-- spaeter startet.
create or replace function public.sqp_anstossen(
  p_tenant uuid,
  p_asin text,
  p_periode text default 'WEEK',
  p_von date default null,
  p_bis date default null
)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'net', 'vault'
as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;

  if p_von is not null and p_bis is not null then
    insert into public.sqp_laeufe (tenant_id, asin, periode, zeitraum_von, zeitraum_bis, status, gestartet)
    values (p_tenant, p_asin, coalesce(p_periode, 'WEEK'), p_von, p_bis, 'laeuft', now())
    on conflict (tenant_id, asin, periode, zeitraum_von) do update
      set status = 'laeuft', gestartet = now(),
          beendet = null, meldung = null, zeilen = null, report_id = null;
  end if;

  return net.http_post(
    url := v_url || '/functions/v1/sync-sqp',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    -- von/bis nur mitschicken, wenn gesetzt: sync-sqp nimmt sonst den letzten
    -- abgeschlossenen Zeitraum der Periode.
    body := jsonb_strip_nulls(jsonb_build_object(
      'tenant_id', p_tenant, 'asin', p_asin,
      'periode', coalesce(p_periode, 'WEEK'), 'von', p_von, 'bis', p_bis
    )),
    timeout_milliseconds := 150000
  );
end $$;

revoke all on function public.sqp_anstossen(uuid, text, text, date, date) from public, anon, authenticated;
grant execute on function public.sqp_anstossen(uuid, text, text, date, date) to service_role;

-- Zeitraeume einer ASIN inklusive Lauf-Status: die Auswahl in der App soll auch
-- Zeitraeume zeigen, die schon einmal versucht wurden und nichts geliefert haben.
create or replace function public.sqp_zeitraeume(p_tenant uuid, p_asin text)
returns table (
  periode text, zeitraum_von date, zeitraum_bis date,
  zeilen bigint, aktualisiert timestamptz,
  status text, meldung text, gestartet timestamptz, beendet timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with daten as (
    select s.periode, s.zeitraum_von, s.zeitraum_bis, count(*) zeilen, max(s.updated_at) aktualisiert
    from public.sqp_rows s
    where s.tenant_id = p_tenant and s.asin = p_asin
    group by s.periode, s.zeitraum_von, s.zeitraum_bis
  ),
  laeufe as (
    select l.periode, l.zeitraum_von, l.zeitraum_bis, l.status, l.meldung, l.gestartet, l.beendet
    from public.sqp_laeufe l
    where l.tenant_id = p_tenant and l.asin = p_asin
  )
  select
    coalesce(d.periode, l.periode),
    coalesce(d.zeitraum_von, l.zeitraum_von),
    coalesce(d.zeitraum_bis, l.zeitraum_bis),
    coalesce(d.zeilen, 0),
    d.aktualisiert,
    l.status, l.meldung, l.gestartet, l.beendet
  from daten d
  full outer join laeufe l
    on l.periode = d.periode and l.zeitraum_von = d.zeitraum_von
  order by 2 desc;
$$;

revoke all on function public.sqp_zeitraeume(uuid, text) from public, anon, authenticated;
grant execute on function public.sqp_zeitraeume(uuid, text) to service_role;

-- Was bisher schon geholt wurde, ruecklaufend als 'fertig' eintragen — sonst
-- stuenden alte Zeitraeume ohne Status da.
insert into public.sqp_laeufe (tenant_id, asin, periode, zeitraum_von, zeitraum_bis, status, zeilen, gestartet, beendet)
select s.tenant_id, s.asin, s.periode, s.zeitraum_von, s.zeitraum_bis,
       'fertig', count(*), max(s.updated_at), max(s.updated_at)
from public.sqp_rows s
group by s.tenant_id, s.asin, s.periode, s.zeitraum_von, s.zeitraum_bis
on conflict (tenant_id, asin, periode, zeitraum_von) do nothing;

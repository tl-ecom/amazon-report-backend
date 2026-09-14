-- Zeitraeume und Anstoss kennen den Marktplatz jetzt ebenfalls.
--
-- `p_marktplatz` ist optional: ohne Angabe gilt der Marktplatz der Verbindung,
-- also genau das bisherige Verhalten. Ein Aufrufer, der nichts von Frankreich
-- weiss, bekommt damit unveraendert seine deutschen Zahlen.
create or replace function public.sqp_zeitraeume(
  p_tenant uuid, p_asin text, p_marktplatz text default null)
returns table(marktplatz text, periode text, zeitraum_von date, zeitraum_bis date,
              zeilen bigint, aktualisiert timestamptz, status text, meldung text,
              gestartet timestamptz, beendet timestamptz)
language sql stable security definer set search_path to 'public'
as $function$
  with ziel as (
    select coalesce(
      p_marktplatz,
      (select ac.marketplace_id from public.auth_contexts ac
        where ac.tenant_id = p_tenant and ac.source = 'sp' limit 1)
    ) as mp
  ),
  daten as (
    select s.marktplatz, s.periode, s.zeitraum_von, s.zeitraum_bis,
           count(*) zeilen, max(s.updated_at) aktualisiert
    from public.sqp_rows s, ziel
    where s.tenant_id = p_tenant and s.asin = p_asin
      and (ziel.mp is null or s.marktplatz = ziel.mp)
    group by s.marktplatz, s.periode, s.zeitraum_von, s.zeitraum_bis
  ),
  laeufe as (
    select l.marktplatz, l.periode, l.zeitraum_von, l.zeitraum_bis,
           l.status, l.meldung, l.gestartet, l.beendet
    from public.sqp_laeufe l, ziel
    where l.tenant_id = p_tenant and l.asin = p_asin
      and (ziel.mp is null or l.marktplatz = ziel.mp)
  )
  select
    coalesce(d.marktplatz, l.marktplatz),
    coalesce(d.periode, l.periode),
    coalesce(d.zeitraum_von, l.zeitraum_von),
    coalesce(d.zeitraum_bis, l.zeitraum_bis),
    coalesce(d.zeilen, 0),
    d.aktualisiert,
    l.status, l.meldung, l.gestartet, l.beendet
  from daten d
  full outer join laeufe l
    on l.marktplatz = d.marktplatz and l.periode = d.periode and l.zeitraum_von = d.zeitraum_von
  order by 3 desc;
$function$;

create or replace function public.sqp_anstossen(
  p_tenant uuid, p_asin text, p_periode text default 'WEEK',
  p_von date default null, p_bis date default null, p_marktplatz text default null)
returns bigint
language plpgsql security definer set search_path to 'public', 'net', 'vault'
as $function$
declare v_url text; v_key text; v_mp text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;

  -- Ohne Angabe der Marktplatz der Verbindung: unveraendertes Verhalten.
  v_mp := coalesce(p_marktplatz,
    (select ac.marketplace_id from public.auth_contexts ac
      where ac.tenant_id = p_tenant and ac.source = 'sp' limit 1));
  if v_mp is null then raise exception 'Kein Marktplatz: weder angegeben noch eine sp-Verbindung vorhanden'; end if;

  if p_von is not null and p_bis is not null then
    insert into public.sqp_laeufe (tenant_id, marktplatz, asin, periode, zeitraum_von, zeitraum_bis, status, gestartet)
    values (p_tenant, v_mp, p_asin, coalesce(p_periode, 'WEEK'), p_von, p_bis, 'laeuft', now())
    on conflict (tenant_id, marktplatz, asin, periode, zeitraum_von) do update
      set status = 'laeuft', gestartet = now(),
          beendet = null, meldung = null, zeilen = null, report_id = null;
  end if;

  return net.http_post(
    url := v_url || '/functions/v1/sync-sqp',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_strip_nulls(jsonb_build_object(
      'tenant_id', p_tenant, 'asin', p_asin,
      'periode', coalesce(p_periode, 'WEEK'), 'von', p_von, 'bis', p_bis,
      'marktplatz', v_mp
    )),
    timeout_milliseconds := 150000
  );
end $function$;

revoke all on function public.sqp_zeitraeume(uuid, text, text) from public, anon, authenticated;
revoke all on function public.sqp_anstossen(uuid, text, text, date, date, text) from public, anon, authenticated;
grant execute on function public.sqp_zeitraeume(uuid, text, text) to service_role;
grant execute on function public.sqp_anstossen(uuid, text, text, date, date, text) to service_role;

-- Die alten Signaturen fallen weg, damit kein Aufrufer still auf der Version
-- ohne Marktplatz haengenbleibt und deutsche mit franzoesischen Zahlen mischt.
drop function if exists public.sqp_zeitraeume(uuid, text);
drop function if exists public.sqp_anstossen(uuid, text, text, date, date);

notify pgrst, 'reload schema';

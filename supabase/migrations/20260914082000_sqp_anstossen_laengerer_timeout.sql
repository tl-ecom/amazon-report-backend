-- Der Abruf darf jetzt laenger dauern: sync-sqp wartet bei Amazons 429
-- (QuotaExceeded, etwa eine Anfrage je Minute bei diesem Report-Typ) einmal ab
-- und versucht es erneut, statt hart zu scheitern. Die Frist in der Function
-- steht auf 240 Sekunden — der pg_net-Timeout muss darueber liegen, sonst
-- meldet der Anstoss einen Timeout, waehrend die Function noch sauber
-- weiterlaeuft und ihr Ergebnis schreibt.
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
    timeout_milliseconds := 260000
  );
end $function$;

revoke all on function public.sqp_anstossen(uuid, text, text, date, date, text) from public, anon, authenticated;
grant execute on function public.sqp_anstossen(uuid, text, text, date, date, text) to service_role;

notify pgrst, 'reload schema';

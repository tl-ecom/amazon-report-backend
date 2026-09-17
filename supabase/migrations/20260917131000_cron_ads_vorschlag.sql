-- Gebotsautomatik Stufe 1 woechentlich rechnen lassen.
--
-- Montags 05:00 UTC: frueh genug, dass die Vorschlaege beim Montags-Check
-- vorliegen, und nach dem naechtlichen Ads-Report-Sync.
--
-- WOECHENTLICH und nicht taeglich mit Absicht. Nach einer Gebotsaenderung
-- braucht Amazon Tage, bis sich Auslieferung und Auktion einpendeln. Wer
-- taeglich nachregelt, misst sein eigenes Einschwingen.
--
-- Der Lauf schreibt nur nach ads_gebot_vorschlaege. Nichts davon geht ohne
-- Freigabe nach Amazon.

create or replace function internal.cron_ads_vorschlag_alle_tenants()
returns integer language plpgsql security definer set search_path = internal, public, net, vault as $$
declare r record; n int := 0; v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;

  -- Nur Tenants, die ueberhaupt eine aktive Regel haben.
  for r in select distinct g.tenant_id from public.ads_gebotsregeln g where g.aktiv loop
    perform net.http_post(
      url := v_url || '/functions/v1/ads-vorschlag',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('tenant_id', r.tenant_id),
      timeout_milliseconds := 150000
    );
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function internal.cron_ads_vorschlag_alle_tenants() from public, anon, authenticated;

select cron.schedule(
  'ads-vorschlag-woechentlich',
  '0 5 * * 1',
  'select internal.cron_ads_vorschlag_alle_tenants()'
);

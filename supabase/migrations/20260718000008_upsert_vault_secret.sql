-- upsert_vault_secret — Secrets aus einer Edge Function in den Vault SCHREIBEN.
--
-- Spiegel zu read_vault_secret (Migration ...0002): Direktzugriff auf das
-- vault-Schema aus Edge Functions war blockiert, deshalb ein public
-- security-definer-Wrapper. read_vault_secret liest, dieser hier schreibt.
--
-- Idempotent über den Namen: existiert ein Secret mit p_name schon, wird sein
-- Wert AKTUALISIERT (gleiche id) statt ein Waisen-Secret anzulegen. Gedacht für
-- deterministische Namen pro Tenant (sp_client_id_<tenant> usw.) — so aktualisiert
-- ein Reconnect dieselben Vault-Einträge, auf die auth_contexts bereits zeigt.
--
-- NUR service_role darf schreiben. Der Klartext-Wert wandert als RPC-Argument
-- über die (interne, TLS-gesicherte) DB-Verbindung — genau wie read_vault_secret
-- den Klartext zurückgibt. Innerhalb der vertrauenswürdigen Backend-Grenze ok.

create or replace function public.upsert_vault_secret(p_name text, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  v_id uuid;
begin
  if p_name is null or p_name = '' then
    raise exception 'p_name darf nicht leer sein';
  end if;

  select id into v_id from vault.secrets where name = p_name;

  if v_id is null then
    v_id := vault.create_secret(p_secret, p_name, 'SP-API Credential (connect-sp)');
  else
    perform vault.update_secret(v_id, p_secret);
  end if;

  return v_id;
end;
$$;

revoke all on function public.upsert_vault_secret(text, text) from public, anon, authenticated;
grant execute on function public.upsert_vault_secret(text, text) to service_role;

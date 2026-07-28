-- Hilfsfunktion: liest ein Vault-Secret entschlüsselt (nur service_role).
-- Wird von den Edge Functions über supabase.rpc('read_vault_secret', ...) aufgerufen.
-- Bereits in der Cloud ausgeführt.

create or replace function public.read_vault_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = vault, public
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where id = p_secret_id
$$;

revoke all on function public.read_vault_secret(uuid) from public, anon, authenticated;
grant execute on function public.read_vault_secret(uuid) to service_role;

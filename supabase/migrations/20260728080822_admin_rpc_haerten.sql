-- Admin-Ändern nicht gewünscht -> Funktion entfernen.
drop function if exists public.admin_setze_admin(uuid, uuid, boolean);

-- Härtung: die self-gating-Listen-RPCs dürfen NICHT direkt von eingeloggten
-- Nutzern (anon/authenticated) über PostgREST aufgerufen werden — sonst könnte
-- jemand mit einer bekannten Admin-UUID die Liste abrufen. Nur der Server
-- (service_role, über die api) darf sie ausführen.
revoke execute on function public.admin_tenant_liste(uuid) from anon, authenticated, public;
revoke execute on function public.admin_kunden_liste(uuid) from anon, authenticated, public;
grant  execute on function public.admin_tenant_liste(uuid) to service_role;
grant  execute on function public.admin_kunden_liste(uuid) to service_role;;

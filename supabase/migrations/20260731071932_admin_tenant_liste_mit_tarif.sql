-- Tarif mitliefern: der Coach braucht ihn für die Teilnehmer-Vorschau
-- (welche Funktionen sähe dieser Kunde?).
drop function if exists public.admin_tenant_liste(uuid);

create function public.admin_tenant_liste(p_caller uuid)
returns table(id uuid, name text, status text, tarif text, member_email text, asin_count bigint, sp_verbunden boolean)
language plpgsql stable security definer set search_path to 'public', 'auth'
as $function$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_caller) then
    return; -- kein Admin -> leer
  end if;
  return query
    select t.id, t.name, t.status, t.tarif,
      (select u.email::text from public.tenant_members m join auth.users u on u.id = m.user_id
         where m.tenant_id = t.id order by m.created_at limit 1) as member_email,
      (select count(*) from public.asins a where a.tenant_id = t.id) as asin_count,
      exists(select 1 from public.auth_contexts ac
               where ac.tenant_id = t.id and ac.source = 'sp' and ac.status = 'connected') as sp_verbunden
    from public.tenants t
    order by t.name;
end
$function$;

revoke all on function public.admin_tenant_liste(uuid) from public, anon, authenticated;
grant execute on function public.admin_tenant_liste(uuid) to service_role;;

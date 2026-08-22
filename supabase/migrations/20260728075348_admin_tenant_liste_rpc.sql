-- Liefert allen Tenants + Repräsentant-E-Mail + Aktivität, ABER nur wenn der
-- Aufrufer (p_caller) Plattform-Admin ist. Self-Gating: direkte Aufrufe durch
-- Nicht-Admins bekommen eine leere Liste.
create or replace function public.admin_tenant_liste(p_caller uuid)
returns table(id uuid, name text, status text, member_email text, asin_count bigint, sp_verbunden boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'auth'
as $function$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_caller) then
    return; -- kein Admin -> leer
  end if;
  return query
    select t.id, t.name, t.status,
      (select u.email::text from public.tenant_members m join auth.users u on u.id = m.user_id
         where m.tenant_id = t.id order by m.created_at limit 1) as member_email,
      (select count(*) from public.asins a where a.tenant_id = t.id) as asin_count,
      exists(select 1 from public.auth_contexts ac
               where ac.tenant_id = t.id and ac.source = 'sp' and ac.status = 'connected') as sp_verbunden
    from public.tenants t
    order by t.name;
end
$function$;

-- Gegencheck: Admin (info@tl-ecom.de) sieht Tenants, ein Kunde nicht.
select
  (select count(*) from public.admin_tenant_liste((select id from auth.users where email='info@tl-ecom.de'))) as als_admin,
  (select count(*) from public.admin_tenant_liste((select id from auth.users where email='thomas.lee@eone-ventures.de'))) as als_kunde;;

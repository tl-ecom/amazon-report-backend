-- Nutzer-/Kundenliste für die Admin-Seite (USER-basiert, damit auch Admins ohne
-- eigene Firma auftauchen). Self-gating: nur Admins bekommen Daten.
create or replace function public.admin_kunden_liste(p_caller uuid)
returns table(user_id uuid, email text, tenant_id uuid, tenant_name text, is_admin boolean,
              asin_count bigint, sp_verbunden boolean, registriert timestamptz)
language plpgsql stable security definer set search_path to 'public','auth'
as $function$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_caller) then return; end if;
  return query
    select u.id,
           u.email::text,
           t.id,
           t.name,
           exists(select 1 from public.platform_admins pa where pa.user_id = u.id) as is_admin,
           coalesce((select count(*) from public.asins a where a.tenant_id = t.id), 0) as asin_count,
           exists(select 1 from public.auth_contexts ac where ac.tenant_id = t.id and ac.source='sp' and ac.status='connected') as sp_verbunden,
           u.created_at
    from auth.users u
    left join lateral (
      select m.tenant_id from public.tenant_members m where m.user_id = u.id order by m.created_at limit 1
    ) mem on true
    left join public.tenants t on t.id = mem.tenant_id
    order by u.created_at;
end $function$;

-- Admin-Rechte setzen/entziehen. Self-gating + Schutz: der LETZTE Admin kann nicht
-- entfernt werden (kein Lockout).
create or replace function public.admin_setze_admin(p_caller uuid, p_target uuid, p_admin boolean)
returns text
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_caller) then
    return 'nicht_admin';
  end if;
  if p_admin then
    insert into public.platform_admins (user_id) values (p_target) on conflict do nothing;
    return 'ok';
  else
    if (select count(*) from public.platform_admins) <= 1 then
      return 'letzter_admin';
    end if;
    delete from public.platform_admins where user_id = p_target;
    return 'ok';
  end if;
end $function$;;

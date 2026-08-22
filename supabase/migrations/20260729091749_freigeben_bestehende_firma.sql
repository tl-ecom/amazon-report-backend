-- Freigabe kann Nutzer optional an eine BESTEHENDE Firma (p_tenant_id) hängen,
-- statt immer eine neue anzulegen. Rückwärtskompatibel: ohne p_tenant_id wie bisher.
create or replace function public.admin_konto_freigeben(
  p_caller uuid,
  p_user_id uuid,
  p_firmenname text default null,
  p_tenant_id uuid default null
) returns void
  language plpgsql
  security definer
  set search_path to 'public', 'auth'
as $function$
declare v_tenant uuid; v_name text;
begin
  if not exists(select 1 from public.platform_admins where user_id = p_caller) then
    raise exception 'nicht autorisiert';
  end if;

  -- Schon Mitglied einer Firma? Dann diese behalten.
  select tenant_id into v_tenant from public.tenant_members
   where user_id = p_user_id order by created_at limit 1;

  if v_tenant is null then
    if p_tenant_id is not null then
      -- An eine BESTEHENDE Firma hängen (muss existieren).
      if not exists(select 1 from public.tenants where id = p_tenant_id) then
        raise exception 'Firma nicht gefunden';
      end if;
      v_tenant := p_tenant_id;
    else
      -- Wie bisher: neue Firma aus Firmenname/Registrierung/E-Mail.
      v_name := coalesce(
        nullif(p_firmenname,''),
        (select nullif(firmenname,'') from public.account_requests where user_id = p_user_id),
        (select email::text from auth.users where id = p_user_id),
        'Neue Firma');
      insert into public.tenants(name) values (v_name) returning id into v_tenant;
    end if;

    if not exists(select 1 from public.tenant_members where user_id = p_user_id and tenant_id = v_tenant) then
      insert into public.tenant_members(user_id, tenant_id, role) values (p_user_id, v_tenant, 'admin');
    end if;
  end if;

  update public.account_requests
     set status='freigegeben', decided_at=now(), decided_by=p_caller
   where user_id = p_user_id;
  if not found then
    insert into public.account_requests(user_id, status, decided_at, decided_by)
    values (p_user_id, 'freigegeben', now(), p_caller);
  end if;
end $function$;

revoke execute on function public.admin_konto_freigeben(uuid,uuid,text,uuid) from anon, authenticated, public;
grant execute on function public.admin_konto_freigeben(uuid,uuid,text,uuid) to service_role;;

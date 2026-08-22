-- Freigeben: legt bei Bedarf Firma + Mitgliedschaft an, setzt Status.
create or replace function public.admin_konto_freigeben(
  p_caller uuid, p_user_id uuid, p_firmenname text default null)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_tenant uuid; v_name text;
begin
  if not exists(select 1 from public.platform_admins where user_id = p_caller) then
    raise exception 'nicht autorisiert';
  end if;

  select tenant_id into v_tenant from public.tenant_members
   where user_id = p_user_id order by created_at limit 1;

  if v_tenant is null then
    v_name := coalesce(
      nullif(p_firmenname,''),
      (select nullif(firmenname,'') from public.account_requests where user_id = p_user_id),
      (select email::text from auth.users where id = p_user_id),
      'Neue Firma');
    insert into public.tenants(name) values (v_name) returning id into v_tenant;
    insert into public.tenant_members(user_id, tenant_id, role) values (p_user_id, v_tenant, 'admin');
  end if;

  update public.account_requests
     set status='freigegeben', decided_at=now(), decided_by=p_caller
   where user_id = p_user_id;
  if not found then
    insert into public.account_requests(user_id, status, decided_at, decided_by)
    values (p_user_id, 'freigegeben', now(), p_caller);
  end if;
end $$;

-- Ablehnen: nur Status setzen (kein Tenant, bleibt gesperrt).
create or replace function public.admin_konto_ablehnen(p_caller uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.platform_admins where user_id = p_caller) then
    raise exception 'nicht autorisiert';
  end if;
  update public.account_requests set status='abgelehnt', decided_at=now(), decided_by=p_caller
   where user_id = p_user_id;
  if not found then
    insert into public.account_requests(user_id, status, decided_at, decided_by)
    values (p_user_id, 'abgelehnt', now(), p_caller);
  end if;
end $$;

-- Selbst-Status: entscheidet im Frontend, ob Dashboard oder Warte-/Abgelehnt-Screen.
create or replace function public.mein_konto_status(p_caller uuid)
returns table(status text, is_admin boolean, has_tenant boolean)
language sql stable security definer set search_path = public as $$
  select
    coalesce((select ar.status from public.account_requests ar where ar.user_id = p_caller), 'wartend'),
    exists(select 1 from public.platform_admins pa where pa.user_id = p_caller),
    exists(select 1 from public.tenant_members m where m.user_id = p_caller)
$$;

-- Kundenliste um Status + Wunsch-Firmenname erweitern (Signatur ändert sich -> neu).
drop function if exists public.admin_kunden_liste(uuid);
create function public.admin_kunden_liste(p_caller uuid)
returns table(user_id uuid, email text, tenant_id uuid, tenant_name text,
              is_admin boolean, status text, wunsch_firma text,
              asin_count bigint, sp_verbunden boolean, registriert timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not exists (select 1 from public.platform_admins where user_id = p_caller) then return; end if;
  return query
    select u.id, u.email::text, t.id, t.name,
      exists(select 1 from public.platform_admins pa where pa.user_id = u.id),
      coalesce(ar.status,'wartend'),
      ar.firmenname,
      coalesce((select count(*) from public.asins a where a.tenant_id = t.id), 0),
      exists(select 1 from public.auth_contexts ac where ac.tenant_id = t.id and ac.source='sp' and ac.status='connected'),
      u.created_at
    from auth.users u
    left join public.account_requests ar on ar.user_id = u.id
    left join lateral (
      select m.tenant_id from public.tenant_members m where m.user_id = u.id order by m.created_at limit 1
    ) mem on true
    left join public.tenants t on t.id = mem.tenant_id
    order by (coalesce(ar.status,'wartend')='wartend') desc, u.created_at;
end $$;

-- Härtung: diese RPCs dürfen NICHT direkt per PostgREST aufrufbar sein
-- (self-gating über p_caller wäre sonst fälschbar). Nur service_role.
revoke execute on function public.admin_konto_freigeben(uuid,uuid,text) from anon, authenticated, public;
revoke execute on function public.admin_konto_ablehnen(uuid,uuid)       from anon, authenticated, public;
revoke execute on function public.admin_kunden_liste(uuid)             from anon, authenticated, public;
revoke execute on function public.mein_konto_status(uuid)             from anon, authenticated, public;
grant  execute on function public.admin_konto_freigeben(uuid,uuid,text) to service_role;
grant  execute on function public.admin_konto_ablehnen(uuid,uuid)       to service_role;
grant  execute on function public.admin_kunden_liste(uuid)             to service_role;
grant  execute on function public.mein_konto_status(uuid)             to service_role;;

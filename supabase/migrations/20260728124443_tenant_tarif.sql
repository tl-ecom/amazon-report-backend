-- Tarif/Mitgliedstyp pro Firma. Grundlage fürs spätere Feature-Gating (§23).
-- premium = Einstieg, vip = mehr Tiefe, coaching = alles.
alter table public.tenants
  add column if not exists tarif text not null default 'premium'
  check (tarif in ('premium','vip','coaching'));

-- Tarif setzen (Admin). Self-gating + nur service_role (wie die übrigen Admin-RPCs).
create or replace function public.admin_setze_tarif(p_caller uuid, p_tenant_id uuid, p_tarif text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_caller) then
    raise exception 'nicht autorisiert';
  end if;
  if p_tarif not in ('premium','vip','coaching') then
    raise exception 'ungültiger Tarif: %', p_tarif;
  end if;
  update public.tenants set tarif = p_tarif where id = p_tenant_id;
end $$;

revoke execute on function public.admin_setze_tarif(uuid,uuid,text) from anon, authenticated, public;
grant  execute on function public.admin_setze_tarif(uuid,uuid,text) to service_role;

-- Kundenliste um tarif erweitern (Signatur ändert sich -> neu anlegen).
drop function if exists public.admin_kunden_liste(uuid);
create function public.admin_kunden_liste(p_caller uuid)
returns table(user_id uuid, email text, tenant_id uuid, tenant_name text, tarif text,
              is_admin boolean, status text, wunsch_firma text,
              asin_count bigint, sp_verbunden boolean, registriert timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_caller) then return; end if;
  return query
    select u.id, u.email::text, t.id, t.name, t.tarif,
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

revoke execute on function public.admin_kunden_liste(uuid) from anon, authenticated, public;
grant  execute on function public.admin_kunden_liste(uuid) to service_role;;

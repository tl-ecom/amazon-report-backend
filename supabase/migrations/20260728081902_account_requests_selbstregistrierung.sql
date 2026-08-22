-- Selbstregistrierung + Freigabe: jeder neue Auth-User startet als "wartend",
-- ein Plattform-Admin gibt ihn frei (legt dabei Firma + Mitgliedschaft an) oder
-- lehnt ab. Bestehende Nutzer werden nach ihrer Tenant-Zugehörigkeit eingeordnet.

create table if not exists public.account_requests (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  status     text not null default 'wartend' check (status in ('wartend','freigegeben','abgelehnt')),
  firmenname text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);

-- Kein direkter Zugriff: nur SECURITY-DEFINER-Funktionen / service_role.
alter table public.account_requests enable row level security;

-- Trigger: jeder neu angelegte Auth-User wird "wartend" (Firmenname aus Metadaten).
create or replace function public.handle_neuer_nutzer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.account_requests(user_id, firmenname)
  values (new.id, nullif(new.raw_user_meta_data->>'firmenname',''))
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_neuer_nutzer();

-- Backfill: bestehende Nutzer mit Tenant = freigegeben, ohne = wartend.
insert into public.account_requests(user_id, status, decided_at)
select u.id,
  case when exists(select 1 from public.tenant_members m where m.user_id = u.id)
       then 'freigegeben' else 'wartend' end,
  now()
from auth.users u
on conflict (user_id) do nothing;;

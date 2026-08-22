-- Plattform-Admins: dürfen die Firma frei wählen (fremde Tenants ansehen).
-- Alle anderen Nutzer sehen ausschließlich ihre eigene Firma (my_tenant_id).
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

-- info@tl-ecom.de = Betreiber/Coach → Admin.
insert into public.platform_admins (user_id)
select id from auth.users where email = 'info@tl-ecom.de'
on conflict do nothing;

select (select count(*) from public.platform_admins) as admins;;

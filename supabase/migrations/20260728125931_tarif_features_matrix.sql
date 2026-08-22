-- Editierbare Tarif-Matrix (§23): welche Funktion (Tab) ist in welchem Tarif aktiv.
-- Pro Tarif ein jsonb feature->bool. Der Admin steuert das im Admin-Tab.
create table if not exists public.tarif_features (
  tarif      text primary key check (tarif in ('premium','vip','coaching')),
  features   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.tarif_features enable row level security;

-- Startwerte: premium = Einstieg, vip = mehr Tiefe + Brief, coaching = alles.
-- (Übersicht ist IMMER aktiv und daher nicht Teil der Matrix.)
insert into public.tarif_features(tarif, features) values
 ('premium',  '{"diagnosen":true,"tasks":false,"brief":false,"aenderungen":false,"experimente":false,"verlauf":false,"sales":true,"orders":false,"listings":false,"ads":false,"returns":false,"products":false}'::jsonb),
 ('vip',      '{"diagnosen":true,"tasks":false,"brief":true,"aenderungen":true,"experimente":false,"verlauf":true,"sales":true,"orders":true,"listings":true,"ads":true,"returns":true,"products":true}'::jsonb),
 ('coaching', '{"diagnosen":true,"tasks":true,"brief":true,"aenderungen":true,"experimente":true,"verlauf":true,"sales":true,"orders":true,"listings":true,"ads":true,"returns":true,"products":true}'::jsonb)
on conflict (tarif) do nothing;

-- Lesen (Admin, self-gated).
create or replace function public.admin_tarif_features(p_caller uuid)
returns table(tarif text, features jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_caller) then return; end if;
  return query select tf.tarif, tf.features from public.tarif_features tf
    order by case tf.tarif when 'premium' then 0 when 'vip' then 1 else 2 end;
end $$;

-- Einzelnes Feature setzen (Admin). Feature-Key-Guard schützt vor jsonb-Key-Injection.
create or replace function public.admin_setze_tarif_feature(
  p_caller uuid, p_tarif text, p_feature text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_caller) then
    raise exception 'nicht autorisiert';
  end if;
  if p_tarif not in ('premium','vip','coaching') then raise exception 'ungültiger Tarif: %', p_tarif; end if;
  if p_feature !~ '^[a-z_]+$' then raise exception 'ungültiges Feature: %', p_feature; end if;
  insert into public.tarif_features(tarif, features)
    values (p_tarif, jsonb_build_object(p_feature, p_enabled))
  on conflict (tarif) do update
    set features = jsonb_set(public.tarif_features.features, array[p_feature], to_jsonb(p_enabled)),
        updated_at = now();
end $$;

revoke execute on function public.admin_tarif_features(uuid)                        from anon, authenticated, public;
revoke execute on function public.admin_setze_tarif_feature(uuid,text,text,boolean) from anon, authenticated, public;
grant  execute on function public.admin_tarif_features(uuid)                        to service_role;
grant  execute on function public.admin_setze_tarif_feature(uuid,text,text,boolean) to service_role;;

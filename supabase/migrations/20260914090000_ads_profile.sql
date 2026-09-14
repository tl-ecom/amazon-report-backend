-- Werbe-Profile je Mandant.
--
-- Pulse holt Ads-Daten heute gegen GENAU EIN Profil: das, was beim Verbinden zum
-- Marktplatz der SP-Verbindung passte — bei allen Mandanten Deutschland. Ein
-- Ads-Profil gilt aber je Marktplatz. Frankreich ist damit gar nicht vorhanden,
-- nicht etwa leer.
--
-- `aktiv` ist bewusst standardmaessig FALSE. Ein neu entdecktes Profil beginnt
-- nicht von selbst, Daten zu ziehen: das kostet API-Kontingent und veraendert
-- Zahlen, die jemand gerade liest. Freischalten ist eine Entscheidung.
create table if not exists public.ads_profile (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  profile_id   text not null,
  country_code text,
  waehrung     text,
  zeitzone     text,
  konto_name   text,
  konto_typ    text,
  marktplatz   text,
  aktiv        boolean not null default false,
  gesehen_am   timestamptz not null default now(),
  primary key (tenant_id, profile_id)
);

alter table public.ads_profile enable row level security;

comment on table public.ads_profile is
  'Werbe-Profile, die der hinterlegte Ads-Token sieht. Ein Profil gilt je Marktplatz. aktiv=false heisst: bekannt, wird aber nicht synchronisiert.';

create or replace function public.ads_profile_holen(p_tenant uuid)
returns bigint
language plpgsql security definer set search_path to 'public', 'net', 'vault'
as $function$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;

  return net.http_post(
    url := v_url || '/functions/v1/sync-ads-profile',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_build_object('tenant_id', p_tenant),
    timeout_milliseconds := 60000
  );
end $function$;

revoke all on function public.ads_profile_holen(uuid) from public, anon, authenticated;
grant execute on function public.ads_profile_holen(uuid) to service_role;

notify pgrst, 'reload schema';

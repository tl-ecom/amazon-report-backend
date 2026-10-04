-- Budget-Auslastung der aktiven SP-Kampagnen, stuendlich gemessen.
--
-- Amazons Stundendaten (Marketing Stream) gibt es nur ueber AWS. Die
-- Budget-Usage-API sagt aber, wie viel Prozent des Tagesbudgets eine Kampagne
-- JETZT verbraucht hat. Stuendlich gefragt, entsteht eine eigene Zeitreihe: ab
-- welcher Messung stand die Kampagne bei 100 %.
--
-- Diese Historie laesst sich nicht nachholen — deshalb zuerst sammeln, dann
-- auswerten.
--
-- Nur Messungen ab 80 % (siehe _shared/ads_budget.ts). Dass gemessen wurde,
-- steht je Lauf in report_jobs (sp-budget-auslastung).
create table if not exists public.ads_budget_auslastung (
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  marktplatz          text not null,
  campaign_id         text not null,
  gemessen_am         timestamptz not null,
  auslastung_prozent  numeric(8,2) not null,
  budget_cents        bigint,
  -- Amazons eigener Stempel der Auslastung; kann hinter gemessen_am liegen.
  amazon_stand        timestamptz,
  primary key (tenant_id, marktplatz, campaign_id, gemessen_am)
);

create index if not exists ads_budget_auslastung_zeit
  on public.ads_budget_auslastung (tenant_id, marktplatz, gemessen_am desc);

alter table public.ads_budget_auslastung enable row level security;

create or replace function internal.stosse_ads_budget_an(p_tenant_id uuid, p_marktplatz text)
  returns bigint
  language plpgsql security definer set search_path to 'internal', 'public', 'net'
as $function$
declare
  v_url  text := internal.vault_secret('project_url');
  v_key  text := internal.vault_secret('service_role_key');
  v_body jsonb := jsonb_build_object('tenant_id', p_tenant_id);
begin
  if v_url is null or v_key is null then
    raise exception 'Vault-Secrets project_url und/oder service_role_key fehlen.';
  end if;
  if p_marktplatz is not null then
    v_body := v_body || jsonb_build_object('marktplatz', p_marktplatz);
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/sync-ads-budget',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := v_body,
    timeout_milliseconds := 60000
  );
end $function$;

revoke all on function internal.stosse_ads_budget_an(uuid, text) from public, anon, authenticated;
grant execute on function internal.stosse_ads_budget_an(uuid, text) to service_role;

-- Stuendlicher Lauf je Mandant und freigeschaltetem Werbe-Profil. Stumm
-- geschaltete Mandanten bleiben aussen vor: um ihr Budget kuemmert sich niemand,
-- und jede Messung kostet API-Kontingent.
create or replace function internal.cron_ads_budget_alle_tenants()
returns int language plpgsql security definer set search_path to 'internal','public' as $function$
declare
  r      record;
  mp     text;
  laender text[];
  n      int := 0;
begin
  for r in
    select ac.tenant_id from public.auth_contexts ac
    join public.tenants tn on tn.id = ac.tenant_id
    where ac.source='ads' and ac.status='connected' and tn.status='active' and not tn.wache_stumm
  loop
    select coalesce(array_agg(m), array[]::text[])
      into laender
      from internal.ads_aktive_marktplaetze(r.tenant_id) m;
    if array_length(laender, 1) is null then
      laender := array[null::text];
    end if;
    foreach mp in array laender loop
      begin
        perform internal.stosse_ads_budget_an(r.tenant_id, mp);
        n := n + 1;
      exception when others then
        raise warning 'ads-budget % / % fehlgeschlagen: %', r.tenant_id, coalesce(mp,'(verbundenes Profil)'), sqlerrm;
      end;
    end loop;
  end loop;
  return n;
end $function$;

notify pgrst, 'reload schema';

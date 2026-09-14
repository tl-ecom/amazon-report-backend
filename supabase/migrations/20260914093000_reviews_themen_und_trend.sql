-- Rezensionsthemen aus der Customer-Feedback-API (SP-API v2024-06-01).
--
-- Dieselben Daten wie im Product Opportunity Explorer: welche Themen Kunden in
-- Rezensionen positiv und negativ nennen, wie oft, mit welchem Einfluss auf die
-- Sternebewertung, und der Verlauf ueber Monate.
--
-- DREI EIGENSCHAFTEN, die den Aufbau bestimmen:
--
-- 1. MARKTPLATZ. Rezensionen sind je Land verschieden. Der Marktplatz steht von
--    Anfang an im Schluessel — nicht nachtraeglich wie bei SQP und Ads, wo
--    genau das zweimal fast zu still ueberschriebenen Zeilen gefuehrt haette.
--
-- 2. WOECHENTLICH. Amazon frischt diese Daten einmal die Woche auf. Der Stand
--    ist deshalb ein Datum, kein Zeitstempel: zwei Abrufe am selben Tag sind
--    derselbe Stand und sollen sich ueberschreiben, nicht verdoppeln.
--
-- 3. ROHDATEN BLEIBEN. `roh` haelt die Antwort, wie sie kam. Die Feldnamen der
--    API sind nicht vollstaendig dokumentiert; was der Parser heute nicht
--    erkennt, ist damit nicht verloren, sondern nachtraeglich auswertbar.

create table if not exists public.reviews_themen (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  marktplatz      text not null,
  asin            text not null,
  stand           date not null,
  richtung        text not null check (richtung in ('positiv','negativ')),
  thema           text not null,
  nennungen       integer,
  anteil          numeric,
  stern_einfluss  numeric,
  anteil_parent   numeric,
  anteil_kategorie numeric,
  schnipsel       jsonb,
  unterthemen     jsonb,
  roh             jsonb,
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, marktplatz, asin, stand, richtung, thema)
);

create table if not exists public.reviews_trend (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  marktplatz      text not null,
  asin            text not null,
  richtung        text not null check (richtung in ('positiv','negativ')),
  thema           text not null,
  monat           date not null,
  bis             date,
  anteil          numeric,
  anteil_parent   numeric,
  anteil_kategorie numeric,
  roh             jsonb,
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, marktplatz, asin, richtung, thema, monat)
);

-- Ein Abruf, der still verschwindet, laesst jeden im Unklaren, ob es keine
-- Themen gibt oder ob Amazon nicht geantwortet hat.
create table if not exists public.reviews_laeufe (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  marktplatz  text not null,
  asin        text not null,
  stand       date not null,
  status      text not null,
  themen      integer,
  trendpunkte integer,
  meldung     text,
  gestartet   timestamptz not null default now(),
  beendet     timestamptz,
  primary key (tenant_id, marktplatz, asin, stand)
);

alter table public.reviews_themen enable row level security;
alter table public.reviews_trend  enable row level security;
alter table public.reviews_laeufe enable row level security;

comment on table public.reviews_themen is
  'Positive und negative Rezensionsthemen je ASIN und Marktplatz, Stand eines Abrufs. Themennamen kommen von Amazon auf ENGLISCH, auch fuer Amazon.de.';
comment on table public.reviews_trend is
  'Monatsverlauf je Thema. occurrencePercentage der ASIN, des Parent und der Kategorie.';

create or replace function public.reviews_anstossen(
  p_tenant uuid, p_asin text default null, p_marktplatz text default null,
  p_limit integer default 10)
returns bigint
language plpgsql security definer set search_path to 'public', 'net', 'vault'
as $function$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;

  return net.http_post(
    url := v_url || '/functions/v1/sync-reviews',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body := jsonb_strip_nulls(jsonb_build_object(
      'tenant_id', p_tenant, 'asin', p_asin, 'marktplatz', p_marktplatz, 'limit', p_limit
    )),
    timeout_milliseconds := 240000
  );
end $function$;

revoke all on function public.reviews_anstossen(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.reviews_anstossen(uuid, text, text, integer) to service_role;

update public.tarif_features
   set features = features || jsonb_build_object('reviews', false),
       updated_at = now()
 where not (features ? 'reviews');

notify pgrst, 'reload schema';

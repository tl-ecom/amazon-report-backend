-- SQP nach Zeitraum: Woche UND Monat nebeneinander, mehrere Perioden je ASIN.
--
-- Bisher hielt sqp_rows genau EINEN Stand je (tenant, asin) — jeder neue Abruf
-- loeschte den alten. Damit sah man in der App immer nur die letzte Woche.
-- Jetzt gehoert die Periode und ihr Anfang zum Schluessel; ein Abruf ersetzt nur
-- noch seinen eigenen Zeitraum.

alter table public.sqp_rows
  add column if not exists periode text not null default 'WEEK';

alter table public.sqp_rows
  drop constraint if exists sqp_rows_periode_chk;
alter table public.sqp_rows
  add constraint sqp_rows_periode_chk check (periode in ('WEEK', 'MONTH'));

-- Ohne Zeitraum ist eine Zeile nicht zuzuordnen — beide Spalten gehoeren in den
-- Schluessel und muessen deshalb gesetzt sein.
alter table public.sqp_rows alter column zeitraum_von set not null;
alter table public.sqp_rows alter column zeitraum_bis set not null;

alter table public.sqp_rows drop constraint sqp_rows_pkey;
alter table public.sqp_rows
  add constraint sqp_rows_pkey primary key (tenant_id, asin, periode, zeitraum_von, search_query);

drop index if exists public.sqp_rows_tenant_asin_idx;
create index sqp_rows_tenant_asin_idx
  on public.sqp_rows (tenant_id, asin, periode, zeitraum_von, volume desc);

-- Welche Zeitraeume liegen fuer eine ASIN schon vor? Treibt die Markierung in
-- der Auswahl ("schon geladen" vs. "noch nicht abgerufen").
create or replace function public.sqp_zeitraeume(p_tenant uuid, p_asin text)
returns table (periode text, zeitraum_von date, zeitraum_bis date, zeilen bigint, aktualisiert timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.periode, s.zeitraum_von, s.zeitraum_bis, count(*), max(s.updated_at)
  from public.sqp_rows s
  where s.tenant_id = p_tenant and s.asin = p_asin
  group by s.periode, s.zeitraum_von, s.zeitraum_bis
  order by s.zeitraum_von desc;
$$;

revoke all on function public.sqp_zeitraeume(uuid, text) from public, anon, authenticated;
grant execute on function public.sqp_zeitraeume(uuid, text) to service_role;

-- Anstoss mit Periode + Zeitraum. Die alte 2-stellige Signatur muss weg, sonst
-- ist der Aufruf mit Default-Argumenten mehrdeutig.
drop function if exists public.sqp_anstossen(uuid, text);

create or replace function public.sqp_anstossen(
  p_tenant uuid,
  p_asin text,
  p_periode text default 'WEEK',
  p_von date default null,
  p_bis date default null
)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'net', 'vault'
as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets project_url/service_role_key fehlen'; end if;
  return net.http_post(
    url := v_url || '/functions/v1/sync-sqp',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    -- von/bis nur mitschicken, wenn gesetzt: sync-sqp nimmt sonst den letzten
    -- abgeschlossenen Zeitraum der Periode.
    body := jsonb_strip_nulls(jsonb_build_object(
      'tenant_id', p_tenant, 'asin', p_asin,
      'periode', coalesce(p_periode, 'WEEK'), 'von', p_von, 'bis', p_bis
    )),
    timeout_milliseconds := 150000
  );
end $$;

revoke all on function public.sqp_anstossen(uuid, text, text, date, date) from public, anon, authenticated;
grant execute on function public.sqp_anstossen(uuid, text, text, date, date) to service_role;

-- Der Cron holt weiterhin nur die Wochensicht. Ohne den periode-Filter wuerde
-- ein manuell geholter Monat die Woche als "frisch" erscheinen lassen.
create or replace function internal.cron_sqp_batch()
returns integer
language plpgsql
security definer
set search_path to 'internal', 'public', 'net', 'vault'
as $$
declare r record; n int := 0; v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise exception 'Vault-Secrets fehlen'; end if;

  for r in (
    with connected as (select distinct tenant_id from public.auth_contexts where source='sp' and status='connected'),
    units as (
      select o.tenant_id, o.asin, sum(o.quantity) q,
             row_number() over (partition by o.tenant_id order by sum(o.quantity) desc) rn
      from public.orders_history o
      join connected c on c.tenant_id = o.tenant_id
      where o.purchase_date::date >= current_date - 90 and o.asin is not null
      group by o.tenant_id, o.asin
    ),
    topn as (select tenant_id, asin, q from units where rn <= 10),
    faellig as (
      select t.tenant_id, t.asin,
        row_number() over (
          partition by t.tenant_id
          order by coalesce((select max(updated_at) from public.sqp_rows s
                             where s.tenant_id=t.tenant_id and s.asin=t.asin and s.periode='WEEK'), 'epoch'::timestamptz) asc,
                   t.q desc
        ) as prio
      from topn t
      where not exists (
        select 1 from public.sqp_rows s
        where s.tenant_id=t.tenant_id and s.asin=t.asin and s.periode='WEEK'
          and s.updated_at > now() - interval '6 days'
      )
    )
    select tenant_id, asin from faellig where prio <= 2
  ) loop
    perform net.http_post(
      url := v_url || '/functions/v1/sync-sqp',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_build_object('tenant_id', r.tenant_id, 'asin', r.asin, 'periode', 'WEEK'),
      timeout_milliseconds := 150000
    );
    n := n + 1;
  end loop;
  return n;
end $$;

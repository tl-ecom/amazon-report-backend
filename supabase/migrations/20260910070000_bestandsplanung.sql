-- Bestandsplanung: Nachbestellen mit Datum und Menge statt nur einer Warnung.
--
-- Was Pulse dafuer braucht und nicht messen kann: Lieferzeit, Transit, die
-- gewuenschte Mindest- und Zielreichweite — und die eigenen Bestellungen, damit
-- die Zeitachse weiss, wann Ware eintrifft. Amazon kennt nur den Zulauf, der
-- schon an FBA angemeldet ist; eine Bestellung beim Hersteller sieht es nie.
--
-- Zwei Ebenen wie bei den ASIN-Einstellungen: Vorgabe je Firma
-- (tenant_einstellungen.plan_*), Ausnahme je Produkt (asin_planung). null heisst
-- ueberall "keine Angabe" — dann gilt die Vorgabe, und fehlt auch die, ein
-- benannter Standardwert, den die Oberflaeche als solchen ausweist.

alter table public.tenant_einstellungen
  add column if not exists plan_lieferzeit_tage     integer,
  add column if not exists plan_transit_tage        integer,
  add column if not exists plan_min_reichweite_tage integer,
  add column if not exists plan_max_reichweite_tage integer,
  add column if not exists plan_velocity_art        text;

alter table public.tenant_einstellungen
  drop constraint if exists tenant_einstellungen_plan_bereich;
alter table public.tenant_einstellungen
  add constraint tenant_einstellungen_plan_bereich check (
    (plan_lieferzeit_tage     is null or plan_lieferzeit_tage     between 0 and 365) and
    (plan_transit_tage        is null or plan_transit_tage        between 0 and 365) and
    (plan_min_reichweite_tage is null or plan_min_reichweite_tage between 0 and 365) and
    (plan_max_reichweite_tage is null or plan_max_reichweite_tage between 1 and 730) and
    (plan_velocity_art is null or plan_velocity_art in ('aktuell_30', 'aktuell_90', 'vorjahr', 'vorjahr_skaliert'))
  );

comment on column public.tenant_einstellungen.plan_velocity_art is
  'Welche Verkaufsgeschwindigkeit die Bestandsplanung fortschreibt: aktuell_30, aktuell_90, vorjahr (Wochenkurve des Vorjahres) oder vorjahr_skaliert (Vorjahr x aktuelles Wachstum). null = aktuell_90.';

create table if not exists public.asin_planung (
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  asin                 text not null,
  lieferzeit_tage      integer,
  transit_tage         integer,
  min_reichweite_tage  integer,
  max_reichweite_tage  integer,
  -- Eigenes Lager / 3PL: Ware, die noch nicht bei Amazon liegt, aber
  -- transferiert werden kann. null = kein Lager bzw. unbekannt, NICHT 0.
  lager_bestand        integer,
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, asin),
  constraint asin_planung_bereich check (
    (lieferzeit_tage     is null or lieferzeit_tage     between 0 and 365) and
    (transit_tage        is null or transit_tage        between 0 and 365) and
    (min_reichweite_tage is null or min_reichweite_tage between 0 and 365) and
    (max_reichweite_tage is null or max_reichweite_tage between 1 and 730) and
    (lager_bestand       is null or lager_bestand >= 0)
  )
);

comment on table public.asin_planung is
  'Planungsparameter je Produkt (Lieferzeit, Transit, Min/Max-Reichweite, eigener Lagerbestand). null = keine Angabe, dann gilt die Firmenvorgabe aus tenant_einstellungen.plan_*.';

alter table public.asin_planung enable row level security;
-- Bewusst keine Policies: Zugriff ausschliesslich ueber die api-Function (service_role).

create table if not exists public.bestellungen (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  asin            text not null,
  menge           integer not null,
  bestellt_am     date not null default current_date,
  -- Erwartete Ankunft am Ziel. Die Zeitachse bucht die Menge an diesem Tag ein.
  erwartet_am     date not null,
  status          text not null default 'bestellt',
  -- fba: geht direkt zu Amazon. lager: ins eigene Lager, noch nicht bei Amazon.
  ziel            text not null default 'fba',
  lieferant       text,
  referenz        text,
  notiz           text,
  eingetroffen_am date,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint bestellungen_menge  check (menge > 0),
  constraint bestellungen_status check (status in ('bestellt', 'produktion', 'unterwegs', 'eingetroffen', 'storniert')),
  constraint bestellungen_ziel   check (ziel in ('fba', 'lager'))
);

create index if not exists bestellungen_tenant_asin_idx on public.bestellungen (tenant_id, asin);
create index if not exists bestellungen_tenant_status_idx on public.bestellungen (tenant_id, status);

comment on table public.bestellungen is
  'Eigene Bestellungen beim Hersteller bzw. Transfers, die Amazon nicht kennt. Offene Bestellungen (bestellt/produktion/unterwegs) mit Ziel fba fliessen in die Bestandszeitachse ein.';

alter table public.bestellungen enable row level security;

-- Basis je ASIN: Absatz 30/90 Tage, derselbe 90-Tage-Abschnitt vor einem Jahr
-- (fuer den Vergleich aktuell vs. Vorjahr), letzter Verkauf, Preis — und der
-- Bestand aus der frischeren Quelle (bestand_je_asin, mit Stand und Quelle).
--
-- FULL OUTER JOIN mit Absicht: ein Produkt mit Bestand, aber ohne Verkauf in
-- 90 Tagen, gehoert in die Planung (kein Absatz), und eins mit Verkaeufen ohne
-- Lagerdatensatz ebenfalls (Bestand unbekannt).
create or replace function public.bestandsplanung_basis(p_tenant uuid)
returns table(asin text, units_30 bigint, units_90 bigint, units_vorjahr_90 bigint,
              letzter_verkauf date, avg_preis_cents integer,
              bestand integer, unterwegs integer, bestand_bekannt boolean,
              bestand_stand timestamptz, bestand_quelle text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with v as (
    select o.asin,
           sum(o.quantity) filter (where o.purchase_date >= now() - interval '30 days') as units_30,
           sum(o.quantity) filter (where o.purchase_date >= now() - interval '90 days') as units_90,
           sum(o.quantity) filter (where o.purchase_date >= now() - interval '1 year' - interval '90 days'
                                     and o.purchase_date <  now() - interval '1 year') as units_vorjahr_90,
           max(o.purchase_date)::date as letzter_verkauf,
           round(avg(o.item_price_cents::numeric / nullif(o.quantity, 0))
                 filter (where o.purchase_date >= now() - interval '90 days'))::int as avg_preis_cents
    from public.orders_history o
    where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
      and coalesce(o.order_status, '') <> 'Cancelled'
    group by o.asin
  ),
  lager as (
    select b.asin, b.bestand, b.unterwegs, b.stand, b.quelle
    from public.bestand_je_asin(p_tenant) b
  )
  select coalesce(v.asin, l.asin) as asin,
         coalesce(v.units_30, 0) as units_30,
         coalesce(v.units_90, 0) as units_90,
         coalesce(v.units_vorjahr_90, 0) as units_vorjahr_90,
         v.letzter_verkauf,
         v.avg_preis_cents,
         l.bestand,
         l.unterwegs,
         (l.asin is not null) as bestand_bekannt,
         l.stand as bestand_stand,
         l.quelle as bestand_quelle
  from v
  full outer join lager l on l.asin = v.asin;
$function$;

revoke all on function public.bestandsplanung_basis(uuid) from public, anon, authenticated;
grant execute on function public.bestandsplanung_basis(uuid) to service_role;

-- Wochenabsatz je ASIN (Montag als Wochenbeginn, wie date_trunc). Grundlage
-- der Vorjahres-Kurve: fuer einen kuenftigen Tag zaehlt die Kalenderwoche, in
-- der derselbe Tag vor einem Jahr lag. Nur Wochen mit Verkaeufen kommen zurueck;
-- eine fehlende Woche innerhalb der Abdeckung heisst 0, nicht unbekannt — das
-- entscheidet der Aufrufer anhand von p_von.
create or replace function public.bestandsplanung_wochen(p_tenant uuid, p_von date)
returns table(asin text, woche date, units bigint)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.asin,
         date_trunc('week', o.purchase_date)::date as woche,
         sum(o.quantity)::bigint as units
  from public.orders_history o
  where o.tenant_id = p_tenant and o.asin is not null and o.quantity > 0
    and coalesce(o.order_status, '') <> 'Cancelled'
    and o.purchase_date >= p_von
  group by 1, 2
  order by 1, 2;
$function$;

revoke all on function public.bestandsplanung_wochen(uuid, date) from public, anon, authenticated;
grant execute on function public.bestandsplanung_wochen(uuid, date) to service_role;

-- Die Bestandsplanung haengt am selben Tarif-Schalter wie der Nachschub-Radar
-- ('nachschub'): derselbe Bereich, nur mit Datum und Menge. Kein neuer Schluessel.

notify pgrst, 'reload schema';

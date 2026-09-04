-- GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA faellt bei Amazon aus: am 03.09. fuenf,
-- am 04.09. vier Versuche, alle FATAL, ohne Fehlerdokument. Elf andere Reports
-- liefen an beiden Tagen sauber — es liegt an diesem Report, nicht am Konto.
-- Historisch gab es schon zwei Bloecke von je vier Ausfalltagen (09.-12.08.,
-- 15.-18.08.).
--
-- Folge: `fba_bestand` war am 04.09. 61 Stunden alt, und Nachschub rechnete
-- Reichweiten auf einem Stand von vorgestern — ohne dass das jemand sah.
--
-- GET_FBA_INVENTORY_PLANNING_DATA liefert dieselbe Menge unter dem Namen
-- `verfuegbar` und lief an beiden Tagen durch (Stand jeweils 04:30). An 40
-- gemeinsamen SKUs verglichen: 23 exakt gleich, Summen 2.861 gegen 2.897
-- (1,3 % auseinander) — das ist Warenbewegung, nicht ein anderer Begriff.
--
-- WAS DIESE FUNKTION NICHT TUT: den Zulauf erfinden. `fba_bestandsalter` kennt
-- keine inbound-Mengen. Im Rueckfall bleibt `unterwegs` deshalb NULL —
-- unbekannt. Sie auf 0 zu setzen hiesse "nichts unterwegs", und das ist eine
-- Aussage, die wir nicht treffen koennen.
--
-- Die Quelle wird mitgeliefert, damit der Rueckfall sichtbar ist statt still.

create or replace function public.bestand_je_asin(p_tenant uuid)
returns table(asin text, bestand integer, unterwegs integer,
              stand timestamptz, quelle text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with myi as (
    select max(f.stand) as stand from public.fba_bestand f where f.tenant_id = p_tenant
  ),
  planung as (
    select max(a.stand) as stand from public.fba_bestandsalter a where a.tenant_id = p_tenant
  ),
  wahl as (
    -- Der Planungsreport gewinnt nur, wenn er DEUTLICH frischer ist. Sonst
    -- wechselte die Quelle bei jedem kleinen Zeitversatz hin und her, und die
    -- Zahlen wackelten ohne dass sich am Lager etwas geaendert haette.
    select case
      when (select stand from myi) is null then 'planung'
      when (select stand from planung) is null then 'myi'
      when (select stand from planung) > (select stand from myi) + interval '12 hours' then 'planung'
      else 'myi'
    end as q
  )
  select f.asin,
         sum(coalesce(f.verkaufsfaehig, 0))::int,
         sum(coalesce(f.inbound_shipped,0) + coalesce(f.inbound_working,0)
             + coalesce(f.inbound_receiving,0))::int,
         max(f.stand),
         'myi'::text
  from public.fba_bestand f cross join wahl
  where wahl.q = 'myi' and f.tenant_id = p_tenant and f.asin is not null
  group by f.asin

  union all

  select a.asin,
         sum(coalesce(a.verfuegbar, 0))::int,
         null::int,   -- Zulauf: dieser Report kennt ihn nicht. NULL, nicht 0.
         max(a.stand),
         'planung'::text
  from public.fba_bestandsalter a cross join wahl
  where wahl.q = 'planung' and a.tenant_id = p_tenant and a.asin is not null
  group by a.asin
$function$;

revoke all on function public.bestand_je_asin(uuid) from public, anon, authenticated;
grant execute on function public.bestand_je_asin(uuid) to service_role;

comment on function public.bestand_je_asin(uuid) is
  'Bestand je ASIN aus der frischeren der beiden Quellen (fba_bestand bzw. fba_bestandsalter). Liefert Stand und Quelle mit; im Rueckfall ist `unterwegs` NULL, weil der Planungsreport keine Zulaufmengen kennt.';

notify pgrst, 'reload schema';;

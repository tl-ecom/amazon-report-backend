-- Getrennte Mandanten meldeten ewig weiter.
--
-- Am 05.10. wurden "e-One" und "Test - Eigener Account" von Amazon getrennt
-- (auth_contexts und Vault-Secrets entfernt). Die Tagesmail vom 06.10. brachte
-- trotzdem wieder die vier Account-Health-Warnungen des Testmandanten.
--
-- Grund: die Hinweis-Funktionen lesen `report_data` mit `is_latest` und pruefen
-- nur `tenants.status` und `wache_stumm` — nicht, ob ueberhaupt noch eine
-- Amazon-Verbindung besteht. Ohne Verbindung laeuft kein Sync mehr, der alte
-- Bericht bleibt also fuer immer `is_latest`, und die Meldung friert ein.
--
-- Das ist der unangenehme Fall: eine Warnung ueber einen Zustand, den niemand
-- mehr aendern kann, weil die Datenquelle weg ist. Sie kostet jeden Tag
-- Aufmerksamkeit und fuehrt zu nichts.
--
-- Eine Hilfsfunktion statt mehrerer Kopien: `ads_hinweise` hatte denselben
-- Fehler, und die naechste Hinweis-Funktion haette ihn auch.
create or replace function public.mandant_verbunden(p_name text)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1
      from public.auth_contexts ac
      join public.tenants t on t.id = ac.tenant_id
     where t.name = p_name and ac.status = 'connected'
  );
$function$;

comment on function public.mandant_verbunden(text) is
  'Hat dieser Mandant noch eine aktive Amazon-Verbindung? Hinweise ohne Verbindung sind eingefroren und nicht mehr handlungsrelevant.';

create or replace function public.account_health_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public'
as $function$
  with berichte as (
    select t.name, rd.payload
      from public.report_data rd
      join public.tenants t on t.id = rd.tenant_id
     where rd.report_type = 'GET_V2_SELLER_PERFORMANCE_REPORT' and rd.is_latest
       and t.status = 'active' and not t.wache_stumm
       -- Ohne Verbindung friert der Bericht ein und die Meldung bliebe ewig.
       and public.mandant_verbunden(t.name)
  ),
  pm as (
    select b.name, m
      from berichte b,
           jsonb_array_elements(coalesce(b.payload -> 'performanceMetrics', '[]'::jsonb)) m
  ),
  flach as (
    select pm.name, pm.m ->> 'marketplaceId' as mp, e.key as kennzahl, e.value as v
      from pm, jsonb_each(pm.m) e
     where jsonb_typeof(e.value) = 'object' and e.value ? 'status'
    union all
    select pm.name, pm.m ->> 'marketplaceId', e.key || '.' || u.key, u.value
      from pm, jsonb_each(pm.m) e, jsonb_each(e.value) u
     where jsonb_typeof(e.value) = 'object' and not (e.value ? 'status')
       and jsonb_typeof(u.value) = 'object' and u.value ? 'status'
  )
  select f.name, 'Account Health',
         format('%s: Amazon meldet %s (Wert %s, Ziel %s) auf %s',
                f.kennzahl, f.v ->> 'status',
                coalesce(f.v ->> 'rate', f.v ->> 'defectsCount', '—'),
                coalesce(f.v ->> 'targetValue', '—'), f.mp)
    from flach f
   where f.v ->> 'status' not in ('GOOD', 'NONE', 'GREAT', 'NORMAL')

  union all

  select pm.name, 'Account Health',
         format('Account-Health-Rating: %s (%s Punkte) auf %s',
                pm.m #>> '{accountHealthRating,ahrStatus}',
                coalesce(pm.m #>> '{accountHealthRating,ahrScore}', '—'), pm.m ->> 'marketplaceId')
    from pm
   where pm.m #>> '{accountHealthRating,ahrStatus}' not in ('GOOD', 'GREAT')

  union all

  select b.name, 'Account Health',
         format('Kontostatus: %s auf %s', s ->> 'status', s ->> 'marketplaceId')
    from berichte b, jsonb_array_elements(coalesce(b.payload -> 'accountStatuses', '[]'::jsonb)) s
   where s ->> 'status' <> 'NORMAL'
$function$;

-- Der Filter sitzt am SAMMLER, nicht in den vier Unterfunktionen. Eine Stelle
-- statt vier, und die naechste Unterfunktion ist automatisch mit abgedeckt.
create or replace function public.ads_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  select h.* from (
    select * from public.budget_hinweise()
    union all
    select * from public.ads_hinweise_begriffe()
    union all
    select * from public.kaufanteil_hinweise()
    union all
    select * from public.produkt_wochenbericht()
  ) h
  where public.mandant_verbunden(h.mandant)
$function$;

notify pgrst, 'reload schema';

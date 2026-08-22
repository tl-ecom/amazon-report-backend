-- settlement_abdeckung — welche Zeitraeume decken die vorliegenden Abrechnungen ab?
--
-- Alles, was aus settlement_zeilen gerechnet wird (Anlieferung, Lagerung,
-- Werbekosten laut Amazon), ist nur so vollstaendig wie die vorliegenden
-- Abrechnungen. Bei Vaneja fehlen am 19.8.2026 zwei Zeitraeume komplett:
-- 07.05.-05.06. und 19.06.-14.07.
--
-- Ohne diese Funktion sehen luecken-bedingt zu niedrige Summen aus wie echte
-- Zahlen, und ein Abgleich gegen sie meldet Abweichungen, die keine sind.
--
-- settlement_start/settlement_end sind in den vorliegenden Daten leer, deshalb
-- die Spanne aus gebucht_am. Das ist eine Naeherung: der wahre Abrechnungs-
-- zeitraum kann etwas weiter reichen als die erste und letzte Buchung darin.

create or replace function public.settlement_abdeckung(p_tenant uuid)
returns table (settlement_id text, von date, bis date, zeilen bigint)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select s.settlement_id,
         min(s.gebucht_am),
         max(s.gebucht_am),
         count(*)::bigint
  from public.settlement_zeilen s
  where s.tenant_id = p_tenant
    and s.gebucht_am is not null
  group by s.settlement_id
  having count(*) > 10          -- Kleinstabrechnungen (Korrekturbuchungen) sind
                                 -- keine Abdeckung eines Zeitraums
  order by min(s.gebucht_am)
$function$;

comment on function public.settlement_abdeckung(uuid) is
  'Zeitraeume, die durch vorliegende Abrechnungen abgedeckt sind (Spanne aus gebucht_am, da settlement_start/-end leer sind). Grundlage fuer die Luecken-Erkennung: alles aus settlement_zeilen ist nur so vollstaendig wie diese Abdeckung.';

revoke all on function public.settlement_abdeckung(uuid) from public;
grant execute on function public.settlement_abdeckung(uuid) to service_role;

notify pgrst, 'reload schema';;

-- Welcher Marktplatz ist fuer diesen Mandanten "der normale"?
--
-- Alle Ads-Lesefunktionen lieferten bisher einfach alles, was in den Tabellen
-- stand — richtig, solange es nur einen Marktplatz gab. Mit einem zweiten Profil
-- wuerden sie deutsche und franzoesische Zahlen in einer Summe mischen. Das ist
-- die gefaehrlichste Art von Fehler: das Ergebnis sieht plausibel aus.
--
-- Diese Funktion gibt den Marktplatz der SP-Verbindung zurueck. Die Leser
-- filtern darauf, solange niemand ausdruecklich ein anderes Land verlangt —
-- bestehende Ansichten bleiben damit Zeichen fuer Zeichen gleich.
create or replace function public.ads_haupt_marktplatz(p_tenant uuid)
returns text
language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(
    (select ac.marketplace_id from public.auth_contexts ac
      where ac.tenant_id = p_tenant and ac.source = 'sp' limit 1),
    (select p.marktplatz from public.ads_profile p
      where p.tenant_id = p_tenant and p.aktiv order by p.country_code limit 1),
    'A1PA6795UKMFR9'
  );
$function$;

revoke all on function public.ads_haupt_marktplatz(uuid) from public, anon, authenticated;
grant execute on function public.ads_haupt_marktplatz(uuid) to service_role;

notify pgrst, 'reload schema';;

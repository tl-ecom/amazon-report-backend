-- Montagsmail: je verwaltetem Produkt ein Hinweis, wenn der Kaufanteil der
-- Kernbegriffe (sqp_produkt_verlauf) eingebrochen ist. Vanejas Biomülleimer
-- fiel von 6,9 % Mitte August auf 1,2 % Mitte September, bei gleichem
-- Suchvolumen — aufgefallen ist es erst am 05.10.
--
-- Einzelne Wochen springen (Etagere: 0,4 / 2,1 / 0,9 %). Verglichen wird
-- deshalb der Schnitt der letzten ZWEI Wochen mit dem besten Schnitt zweier
-- aufeinanderfolgender Wochen: unter der Haelfte, und der beste Schnitt
-- mindestens 1 %. Mindestens vier Wochen muessen vorliegen.
create or replace function public.kaufanteil_hinweise(p_immer boolean default false)
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  with mandanten as (
    select ac.tenant_id, t.name, public.ads_haupt_marktplatz(ac.tenant_id) as marktplatz
      from public.auth_contexts ac
      join public.tenants t on t.id = ac.tenant_id
     where ac.source = 'ads' and ac.status = 'connected' and t.status = 'active'
       and not t.wache_stumm
       and exists (select 1 from public.ads_steuerung s where s.tenant_id = ac.tenant_id)
       and (p_immer or extract(isodow from now() at time zone 'Europe/Berlin') = 1)
  ),
  produkte as (
    select m.name, p
      from mandanten m,
           jsonb_array_elements(public.sqp_produkt_verlauf(m.tenant_id, m.marktplatz, 1)) p
     where m.marktplatz is not null
  ),
  wochen as (
    select pr.name, pr.p ->> 'produkt' as produkt, (pr.p ->> 'kern_begriffe')::int as kern,
           (w ->> 'von')::date as von, (w ->> 'kern_kaufanteil')::numeric as anteil,
           (w ->> 'kern_volumen')::numeric as volumen
      from produkte pr, jsonb_array_elements(pr.p -> 'wochen') w
     where w ->> 'kern_kaufanteil' is not null
  ),
  paare as (
    select w.*,
           avg(anteil) over z as schnitt2, avg(volumen) over z as volumen2, count(*) over z as n2,
           row_number() over (partition by name, produkt order by von desc) as von_hinten,
           count(*) over (partition by name, produkt) as n
      from wochen w
    window z as (partition by name, produkt order by von rows between 1 preceding and current row)
  ),
  beste as (
    select distinct on (name, produkt) name, produkt, von, schnitt2, volumen2
      from paare where n2 = 2 order by name, produkt, schnitt2 desc
  )
  select l.name, 'Kaufanteil eingebrochen ' || l.produkt,
         format('Kaufanteil der %s Kernbegriffe: %s %% im Schnitt der letzten zwei Wochen (bis Woche ab %s), '
                || 'bester Zwei-Wochen-Schnitt %s %% (bis Woche ab %s). Suchvolumen dabei %s gegen %s je Woche — '
                || '%s. Werbung und organisch zusammen; Details im Bereich Ads-Budget, Kaufanteil je Suchbegriff.',
                l.kern, to_char(l.schnitt2, 'FM990D0'), to_char(l.von, 'DD.MM.'),
                to_char(b.schnitt2, 'FM990D0'), to_char(b.von, 'DD.MM.'),
                to_char(l.volumen2, 'FM9999990'), to_char(b.volumen2, 'FM9999990'),
                case when l.volumen2 >= 0.85 * b.volumen2 then 'die Nachfrage ist nicht gefallen, gekauft wird woanders'
                     else 'auch die Nachfrage ist gefallen' end)
    from paare l
    join beste b on b.name = l.name and b.produkt = l.produkt
   where l.von_hinten = 1 and l.n >= 4 and l.n2 = 2
     and b.schnitt2 >= 1 and l.schnitt2 < 0.5 * b.schnitt2
$function$;

revoke all on function public.kaufanteil_hinweise(boolean) from public, anon, authenticated;
grant execute on function public.kaufanteil_hinweise(boolean) to service_role;

create or replace function public.ads_hinweise()
returns table(mandant text, art text, detail text)
language sql stable security definer set search_path to 'public', 'internal'
as $function$
  select * from public.budget_hinweise()
  union all
  select * from public.ads_hinweise_begriffe()
  union all
  select * from public.kaufanteil_hinweise()
  union all
  select * from public.produkt_wochenbericht()
$function$;

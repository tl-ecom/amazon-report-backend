-- Der Hinweis "Kaufanteil eingebrochen" verwies nur auf den Bereich Ads-Budget.
-- Jetzt nennt er gleich, wo es fehlt: den Kernbegriff mit dem groessten
-- Verlust (Suchvolumen x Kaufanteil, beste Woche gegen letzte) und die
-- Kampagne, die ueber diesen Begriff die meisten Werbeklicks verloren hat.
-- Vanejas Biomülleimer: "biomülleimer küche", Ranking-Kampagne 256 -> 56 Klicks.
create or replace function public.kaufanteil_hinweis_detail(p_tenant uuid, p_marktplatz text, p_produkt text)
returns text
language sql stable security definer set search_path to 'public'
as $function$
  with p as (
    select x from jsonb_array_elements(public.sqp_produkt_verlauf(p_tenant, p_marktplatz, 10)) x
     where x ->> 'produkt' = p_produkt
  ),
  letzte as (select max((w ->> 'von')::date) as von from p, jsonb_array_elements(p.x -> 'wochen') w),
  bw as (
    select b ->> 'begriff' as begriff, (w ->> 'von')::date as von,
           (w ->> 'volumen')::numeric as vol, (w ->> 'kaufanteil')::numeric as ant
      from p, jsonb_array_elements(p.x -> 'begriffe') b, jsonb_array_elements(b -> 'wochen') w
     where (b ->> 'kern')::boolean
  ),
  beste as (select distinct on (begriff) begriff, von, vol, ant from bw order by begriff, ant desc, von),
  top as (
    select be.begriff, be.von as best_von, be.ant as best_ant, l.ant as last_ant
      from beste be
      left join bw l on l.begriff = be.begriff and l.von = (select von from letzte)
     order by be.vol * be.ant - coalesce(l.vol * l.ant, 0) desc
     limit 1
  ),
  k as (
    select z ->> 'campaign_name' as name,
           coalesce(sum((z ->> 'klicks')::int) filter (where (z ->> 'von')::date = top.best_von), 0) as kb,
           coalesce(sum((z ->> 'klicks')::int) filter (where (z ->> 'von')::date = letzte.von), 0) as kl
      from top cross join letzte,
           jsonb_array_elements(public.ads_suchbegriff_kampagnen_wochen(
             p_tenant, p_marktplatz, array[top.begriff], array[top.best_von, letzte.von])) z
     where top.best_von <> letzte.von
     group by 1
     order by 2 - 3 desc
     limit 1
  )
  select format(' Groesster Verlust: "%s", Kaufanteil %s %% (Woche ab %s) auf %s %%.%s',
                top.begriff, to_char(top.best_ant, 'FM990D0'), to_char(top.best_von, 'DD.MM.'),
                coalesce(to_char(top.last_ant, 'FM990D0'), '?'),
                coalesce((select format(' Werbeklicks der Kampagne %s ueber diesen Begriff: %s auf %s.', k.name, k.kb, k.kl)
                            from k where k.kb > k.kl), ''))
    from top
$function$;

revoke all on function public.kaufanteil_hinweis_detail(uuid, text, text) from public, anon, authenticated;
grant execute on function public.kaufanteil_hinweis_detail(uuid, text, text) to service_role;

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
    select m.tenant_id, m.marktplatz, m.name, p
      from mandanten m,
           jsonb_array_elements(public.sqp_produkt_verlauf(m.tenant_id, m.marktplatz, 1)) p
     where m.marktplatz is not null
  ),
  wochen as (
    select pr.tenant_id, pr.marktplatz, pr.name, pr.p ->> 'produkt' as produkt, (pr.p ->> 'kern_begriffe')::int as kern,
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
                || '%s.%s Werbung und organisch zusammen; Details im Bereich Ads-Budget, Kaufanteil je Suchbegriff.',
                l.kern, to_char(l.schnitt2, 'FM990D0'), to_char(l.von, 'DD.MM.'),
                to_char(b.schnitt2, 'FM990D0'), to_char(b.von, 'DD.MM.'),
                to_char(l.volumen2, 'FM9999990'), to_char(b.volumen2, 'FM9999990'),
                case when l.volumen2 >= 0.85 * b.volumen2 then 'die Nachfrage ist nicht gefallen, gekauft wird woanders'
                     else 'auch die Nachfrage ist gefallen' end,
                coalesce(public.kaufanteil_hinweis_detail(l.tenant_id, l.marktplatz, l.produkt), ''))
    from paare l
    join beste b on b.name = l.name and b.produkt = l.produkt
   where l.von_hinten = 1 and l.n >= 4 and l.n2 = 2
     and b.schnitt2 >= 1 and l.schnitt2 < 0.5 * b.schnitt2
$function$;

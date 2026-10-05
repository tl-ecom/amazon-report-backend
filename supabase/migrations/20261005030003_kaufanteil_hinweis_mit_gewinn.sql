-- Ein gefallener Kaufanteil ist kein Schaden, wenn der Gewinn haelt. Vanejas
-- Biomülleimer: Kaufanteil 5,4 -> 1,9 %, Gewinn nach Werbung je Woche aber
-- gleich, weil teurer Werbeumsatz wegfiel. Der Hinweis nennt deshalb den
-- Gewinn nach Werbung daneben und heisst nur dann "eingebrochen", wenn auch
-- der Gewinn gefallen ist.
--
-- Die Marge vor Werbung rechnet TypeScript (Produktuebersicht, Gebuehren,
-- Einkaufspreise) — SQL kann das nicht nachbauen. ads_produkt_lage.ts legt sie
-- je Produkt hier ab; sync-ads-budget frischt sie einmal am Tag auf.
create table public.ads_produkt_marge (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  marktplatz text not null,
  produkt text not null,
  -- Deckungsbeitrag vor Werbung je Euro Bruttoumsatz. null = unbekannt (kaum Gebuehren abgerechnet).
  marge numeric,
  berechnet_am timestamptz not null default now(),
  primary key (tenant_id, marktplatz, produkt)
);
alter table public.ads_produkt_marge enable row level security; -- nur Service-Rolle

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
           lag(von) over (partition by name, produkt order by von) as von_davor,
           row_number() over (partition by name, produkt order by von desc) as von_hinten,
           count(*) over (partition by name, produkt) as n
      from wochen w
    window z as (partition by name, produkt order by von rows between 1 preceding and current row)
  ),
  beste as (
    select distinct on (name, produkt) name, produkt, von, von_davor, schnitt2, volumen2
      from paare where n2 = 2 order by name, produkt, schnitt2 desc
  ),
  treffer as (
    select l.tenant_id, l.marktplatz, l.name, l.produkt, l.kern,
           l.von as l_von, l.von_davor as l_davor, l.schnitt2 as l_schnitt, l.volumen2 as l_vol,
           b.von as b_von, b.von_davor as b_davor, b.schnitt2 as b_schnitt, b.volumen2 as b_vol
      from paare l
      join beste b on b.name = l.name and b.produkt = l.produkt
     where l.von_hinten = 1 and l.n >= 4 and l.n2 = 2
       and b.schnitt2 >= 1 and l.schnitt2 < 0.5 * b.schnitt2
  ),
  -- Tageswerte nur fuer Mandanten mit Treffer: Umsatz aus allen Bestellungen und Werbekosten.
  tage as (
    select m.tenant_id, z ->> 'produkt' as produkt, (z ->> 'datum')::date as datum,
           (z ->> 'spend_cents')::numeric / 100 as kosten, (z ->> 'umsatz_cents')::numeric / 100 as umsatz
      from (select distinct tenant_id, marktplatz from treffer) m,
           jsonb_array_elements(public.ads_produkt_verlauf(m.tenant_id, m.marktplatz, 150) -> 'zeilen') z
  ),
  gewinn as (
    select t.tenant_id, t.produkt, mg.marge,
           -- je Woche: zwei Wochen summiert, durch zwei
           (select (sum(d.umsatz) * mg.marge - sum(d.kosten)) / 2 from tage d
             where d.tenant_id = t.tenant_id and d.produkt = t.produkt
               and (d.datum between t.b_davor and t.b_davor + 6 or d.datum between t.b_von and t.b_von + 6)) as damals,
           (select (sum(d.umsatz) * mg.marge - sum(d.kosten)) / 2 from tage d
             where d.tenant_id = t.tenant_id and d.produkt = t.produkt
               and (d.datum between t.l_davor and t.l_davor + 6 or d.datum between t.l_von and t.l_von + 6)) as zuletzt,
           (select sum(d.umsatz) * mg.marge - sum(d.kosten) from tage d
             where d.tenant_id = t.tenant_id and d.produkt = t.produkt
               and d.datum > (select max(x.datum) from tage x where x.tenant_id = t.tenant_id) - 7) as aktuell,
           (select max(x.datum) from tage x where x.tenant_id = t.tenant_id) as daten_bis
      from treffer t
      left join public.ads_produkt_marge mg on mg.tenant_id = t.tenant_id and mg.marktplatz = t.marktplatz
                                           and mg.produkt = t.produkt
  )
  select t.name,
         case when g.marge is null or g.damals is null or g.aktuell is null then 'Kaufanteil eingebrochen '
              when g.aktuell >= 0.9 * g.damals then 'Kaufanteil gefallen, Gewinn gehalten '
              else 'Kaufanteil und Gewinn gefallen ' end || t.produkt,
         format('Kaufanteil der %s Kernbegriffe: %s %% im Schnitt der letzten zwei Wochen (bis Woche ab %s), '
                || 'bester Zwei-Wochen-Schnitt %s %% (bis Woche ab %s). Suchvolumen dabei %s gegen %s je Woche — '
                || '%s. %s%s Kaufanteil ist Werbung und organisch zusammen; Details im Bereich Ads-Budget.',
                t.kern, to_char(t.l_schnitt, 'FM990D0'), to_char(t.l_von, 'DD.MM.'),
                to_char(t.b_schnitt, 'FM990D0'), to_char(t.b_von, 'DD.MM.'),
                to_char(t.l_vol, 'FM9999990'), to_char(t.b_vol, 'FM9999990'),
                case when t.l_vol >= 0.85 * t.b_vol then 'die Nachfrage ist nicht gefallen, gekauft wird woanders'
                     else 'auch die Nachfrage ist gefallen' end,
                case when g.marge is null or g.damals is null or g.aktuell is null
                     then 'Gewinn nach Werbung unbekannt (keine belastbare Marge).'
                     else format('Gewinn nach Werbung je Woche: damals %s EUR, in den letzten zwei Wochen mit Kaufanteil %s EUR, '
                                 || 'aktuell (7 Tage bis %s) %s EUR, gerechnet mit %s %% Marge vor Werbung.',
                                 to_char(g.damals, 'FM999990'), coalesce(to_char(g.zuletzt, 'FM999990'), '?'),
                                 to_char(g.daten_bis, 'DD.MM.'), to_char(g.aktuell, 'FM999990'),
                                 to_char(100 * g.marge, 'FM990D0')) end,
                coalesce(public.kaufanteil_hinweis_detail(t.tenant_id, t.marktplatz, t.produkt), ''))
    from treffer t
    join gewinn g on g.tenant_id = t.tenant_id and g.produkt = t.produkt
$function$;

-- Die Ereignisse je Produkt kannten am Werbekonto nur, was ueber Pulse lief.
-- Der taegliche Struktur-Abgleich (ads_struktur_aenderungen, seit 04.10.2026)
-- sieht jede Aenderung, egal von wem: Helium-10-KI, Seller Central, Pulse.
--   * Gebotsaenderungen: je Produkt und Tag gezaehlt.
--   * Kampagne (Budget, Zustand, Platzierungs-Aufschlag): einzeln — ausser
--     Pulse hat am selben Tag an derselben Kampagne geschrieben; das steht
--     dann schon aus dem Pulse-Protokoll da.
-- Eingefuegt als weiterer Baustein vor "alle"; der Rest der Funktion bleibt.
do $$
declare
  def text := pg_get_functiondef('public.ads_produkt_ereignisse(uuid, text, integer)'::regprocedure);
  alt constant text := $a$  alle as (
    select * from listing union all$a$;
  neu text;
begin
  neu := replace(def, alt, $a$  fremd as (
    select s.produkt, (a.erkannt_am at time zone 'Europe/Berlin')::date as datum, 'werbung' as art,
           'Gebotsänderungen im täglichen Abgleich erkannt (alle Quellen: Helium 10, Pulse, Seller Central)' as text,
           count(*)::int as anzahl
      from gesteuert s
      join public.ads_struktur_aenderungen a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                                            and a.marktplatz = p_marktplatz
     where a.ebene = 'ziel' and a.feld = 'gebot_cents'
     group by 1, 2
    union all
    select s.produkt, (a.erkannt_am at time zone 'Europe/Berlin')::date, 'werbung',
           case a.feld
             when 'budget_cents' then format('Budget %s → %s EUR (nicht über Pulse): %s',
                    coalesce(to_char(a.vorher::numeric / 100, 'FM999990D00'), '—'),
                    coalesce(to_char(a.nachher::numeric / 100, 'FM999990D00'), '—'), a.bezeichnung)
             when 'state' then format('Kampagne %s → %s (nicht über Pulse): %s', a.vorher, a.nachher, a.bezeichnung)
             else format('%s %s → %s (nicht über Pulse): %s', a.feld, coalesce(a.vorher, '0'), coalesce(a.nachher, '0'), a.bezeichnung) end,
           1
      from gesteuert s
      join public.ads_struktur_aenderungen a on a.tenant_id = p_tenant and a.campaign_id = s.campaign_id
                                            and a.marktplatz = p_marktplatz
     where a.ebene = 'kampagne'
       and not exists (
             select 1 from public.ads_aenderungen_log l
              where l.tenant_id = p_tenant and l.campaign_id = a.campaign_id and l.ergebnis = 'ok'
                and (l.created_at at time zone 'Europe/Berlin')::date
                    between (a.erkannt_am at time zone 'Europe/Berlin')::date - 1
                        and (a.erkannt_am at time zone 'Europe/Berlin')::date)
  ),
  alle as (
    select * from fremd union all
    select * from listing union all$a$);
  if neu = def then raise exception 'Einfuegestelle nicht gefunden'; end if;
  execute neu;
end $$;

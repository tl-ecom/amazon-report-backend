-- Selbstblockade: nur echte Blockaden melden.
--
-- Die erste Fassung traf bei Vaneja 20+ Paare, fast alle Broad-/Phrase-Keyword
-- mit Negative Exact desselben Texts. Das ist kein Fehler, sondern gewollte
-- Isolation: Die exakte Suchanfrage soll ueber die Exact-Kampagne laufen, das
-- Broad-Keyword faengt nur die Varianten. Wer das meldet, erzeugt Rauschen.
--
-- Echt blockiert ist ein Keyword nur, wenn KEINE seiner Suchanfragen mehr
-- durchkommt:
--   Exact-Keyword  + Negative Exact gleichen Texts
--   Exact-/Phrase-Keyword + Negative Phrase, die im Keyword als Wortfolge steckt
-- Broad + Negative Phrase blockiert nur teilweise und bleibt draussen.

create or replace function public.ads_selbstblockaden(p_tenant uuid, p_stand timestamptz)
returns table (
  campaign_id text, campaign_name text, ad_group_id text,
  keyword_id text, keyword text, keyword_match text, gebot_cents bigint,
  negative_id text, negative text, negative_match text, negative_ebene text
)
language sql stable security definer set search_path to 'public'
as $function$
  select k.campaign_id, c.name, k.ad_group_id,
         k.ziel_id, k.text, k.match_type, k.gebot_cents,
         n.ziel_id, n.text, n.match_type,
         case when n.art like 'kampagne_%' then 'kampagne' else 'anzeigengruppe' end
  from public.ads_ziele k
  join public.ads_ziele n
    on n.tenant_id = k.tenant_id and n.gesehen_am = k.gesehen_am
   and n.campaign_id = k.campaign_id
   and n.art in ('negativ_keyword', 'kampagne_negativ_keyword')
   and n.state = 'ENABLED'
   and (n.art = 'kampagne_negativ_keyword' or n.ad_group_id = k.ad_group_id)
   and (
        (k.match_type = 'EXACT' and n.match_type = 'NEGATIVE_EXACT'
           and lower(n.text) = lower(k.text))
     or (k.match_type in ('EXACT', 'PHRASE') and n.match_type = 'NEGATIVE_PHRASE'
           and ' ' || lower(k.text) || ' ' like '% ' || lower(n.text) || ' %')
   )
  left join public.ads_kampagnen c on c.tenant_id = k.tenant_id and c.campaign_id = k.campaign_id
  where k.tenant_id = p_tenant and k.gesehen_am = p_stand
    and k.art = 'keyword' and k.state = 'ENABLED'
  order by k.campaign_id, k.text
$function$;

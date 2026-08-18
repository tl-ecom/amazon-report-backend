-- Werbekosten laut ABRECHNUNG als eigene Kategorie in betriebskosten_summen.
--
-- Nicht als Kostenposten gedacht - die Werbung steht bereits im Ads-Bereich aus
-- der Ads-API. Hier dient sie als GEGENPROBE: zwei unabhaengige Quellen fuer
-- dieselbe Groesse. Weichen sie stark ab, stimmt eine von beiden nicht.
--
-- Achtung beim Vergleich: Die Ads-API bucht nach Anzeigentag, die Abrechnung
-- nach Buchungstag. Kleine Abweichungen sind normal, grosse ein Signal. Und
-- Werbung kann per Karte statt ueber das Guthaben belastet werden - dann fehlt
-- sie auf der Abrechnungsseite, ohne dass ein Fehler vorliegt.

create or replace function public.betriebskosten_summen(p_tenant uuid, p_von date, p_bis date)
returns table (
  kategorie              text,
  netto_ausgewiesen_cents bigint,
  steuer_ausgewiesen_cents bigint,
  brutto_ohne_ausweis_cents bigint,
  zeilen                 bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with eingeordnet as (
    select
      case
        when s.betrag_beschreibung in ('FBAInboundTransportationFee', 'FBAInboundTransportationProgramFee')
          or s.betrag_typ in ('FBA Amazon-Partnered Carrier Shipment Fee', 'Inbound Transportation Program Fee')
          then 'anlieferung'
        when s.betrag_typ = 'FBA Inventory Storage Fee'      then 'lagerung'
        when s.betrag_typ = 'FBA Long Term Storage Fee'      then 'langzeitlagerung'
        when s.betrag_typ = 'FBA Removal Order: Return Fee'
          or s.betrag_beschreibung = 'DisposalComplete'      then 'entfernung'
        when s.betrag_typ = 'FBA Inventory Reimbursement'    then 'erstattungen'
        when s.betrag_typ = 'Cost of Advertising'            then 'werbung'
        else null
      end as kategorie,
      s.betrag_beschreibung,
      s.betrag_cents
    from public.settlement_zeilen s
    where s.tenant_id = p_tenant
      and s.gebucht_am between p_von and p_bis
  )
  select
    kategorie,
    coalesce(sum(betrag_cents) filter (where betrag_beschreibung = 'Base fee'), 0)::bigint,
    coalesce(sum(betrag_cents) filter (where betrag_beschreibung = 'Tax on fee'), 0)::bigint,
    coalesce(sum(betrag_cents) filter (
      where betrag_beschreibung is distinct from 'Base fee'
        and betrag_beschreibung is distinct from 'Tax on fee'), 0)::bigint,
    count(*)::bigint
  from eingeordnet
  where kategorie is not null
  group by kategorie
$function$;

notify pgrst, 'reload schema';

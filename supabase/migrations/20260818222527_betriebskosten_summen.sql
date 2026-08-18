-- betriebskosten_summen — Kosten, die NICHT am einzelnen Verkauf haengen.
--
-- Anlieferung ins Lager, Lagerung, Langzeitlagerung, Entfernung/Entsorgung und
-- die Gutschriften fuer verlorene Ware. Sie stehen in den Abrechnungsberichten
-- (settlement_zeilen), NICHT in finance_gebuehren: die Finances-Auswertung
-- greift nur FeeAmount-Knoten ab, diese Buchungen kommen anders strukturiert.
--
-- BEWUSST GETRENNT von den Verkaufsgebuehren: Anlieferung gehoert nicht in die
-- Gebuehrenspalte des Break-even. Sie faellt je Lieferung an, nicht je Verkauf,
-- und eine Umlage auf Produkte waere geraten.
--
-- STEUER: Amazon meldet sie in zwei Formaten, je nach Alter der Abrechnung.
--   neu: getrennte Zeilen 'Base fee' (netto) und 'Tax on fee' (Steuer)
--   alt: EINE Zeile mit dem Bruttobetrag, ohne Steuerausweis
-- Verifiziert an echten Daten: dieselben Anlieferkosten erscheinen in aelteren
-- Abrechnungen als 'FBAInboundTransportationFee', in neueren als 'FBA
-- Amazon-Partnered Carrier Shipment Fee' mit eigener Steuerzeile. KEINE
-- Doppelzaehlung — die Formate stammen aus verschiedenen Abrechnungen.
--
-- Deshalb drei Summen statt einer. Die Aufteilung im alten Format kann nur
-- gerechnet werden, nicht abgelesen — das muss die Anzeige kenntlich machen,
-- statt es zu verwischen.
--
-- Nur Summen, keine Netto-Umrechnung: der Steuerfaktor haengt am Steuerprofil
-- des Mandanten und gehoert nach _shared, wo er getestet ist.

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

comment on function public.betriebskosten_summen(uuid, date, date) is
  'Nicht-verkaufsbezogene Kosten aus settlement_zeilen je Kategorie (Anlieferung, Lagerung, Langzeitlagerung, Entfernung, Erstattungen). Liefert drei Summen, weil Amazon die Steuer je nach Abrechnungsalter getrennt ausweist oder im Betrag fuehrt.';

revoke all on function public.betriebskosten_summen(uuid, date, date) from public;
grant execute on function public.betriebskosten_summen(uuid, date, date) to service_role;

notify pgrst, 'reload schema';

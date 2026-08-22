drop function if exists public.abrechnungen(uuid);

-- Auszahlungen je Abrechnungszeitraum. Beantwortet: Warum ist die Auszahlung
-- kleiner als der Umsatz?
--
-- Jede Zeile faellt in GENAU EINEN Topf (eine CASE-Kette, kein Satz von
-- ueberlappenden Filtern). Der erste Versuch zaehlte 'ShippingTax' doppelt,
-- weil es sowohl %Tax% als auch %Shipping% traf — der Wasserfall ging nicht auf.
-- So ist die Summe der Toepfe zwangslaeufig die Summe aller Zeilen, und eine
-- Abweichung zur genannten Auszahlung ist ein echtes Signal statt eines
-- Rechenfehlers.
create function public.abrechnungen(p_tenant uuid)
returns table (
  settlement_id text, von date, bis date, auszahlung_datum date,
  auszahlung_cents bigint, summe_positionen_cents bigint,
  umsatz_cents bigint, steuer_cents bigint, versand_cents bigint,
  gebuehren_cents bigint, werbung_cents bigint, lager_cents bigint,
  erstattung_cents bigint, promotion_cents bigint, sonstiges_cents bigint,
  positionen int
)
language sql stable security definer set search_path to 'public'
as $$
  with klassifiziert as (
    select s.settlement_id, s.betrag_cents, s.gebucht_am,
           case
             when s.betrag_typ = 'ItemPrice' and s.betrag_beschreibung = 'Principal' then 'umsatz'
             when s.betrag_typ = 'ItemPrice' and s.betrag_beschreibung = 'Shipping' then 'versand'
             when s.betrag_typ = 'ItemPrice' then 'steuer'          -- Tax, ShippingTax, ...
             when s.betrag_typ = 'ItemFees' then 'gebuehren'
             when s.betrag_typ ilike '%Advertising%' then 'werbung'
             when s.betrag_typ ilike '%Storage Fee%' then 'lager'
             when s.betrag_typ ilike '%Reimbursement%' then 'erstattung'
             when s.betrag_typ = 'Promotion' then 'promotion'
             else 'sonstiges'
           end as topf
    from public.settlement_zeilen s
    where s.tenant_id = p_tenant and s.settlement_id is not null
      and s.betrag_typ is not null
  ),
  kopf as (
    select settlement_id,
           max(settlement_start) as von, max(settlement_end) as bis,
           max(auszahlung_datum) as auszahlung_datum,
           max(gesamtbetrag_cents) as auszahlung_cents
    from public.settlement_zeilen
    where tenant_id = p_tenant and settlement_id is not null and betrag_typ is null
    group by settlement_id
  )
  select k.settlement_id,
         coalesce(kopf.von, min(k.gebucht_am)) as von,
         coalesce(kopf.bis, max(k.gebucht_am)) as bis,
         kopf.auszahlung_datum,
         kopf.auszahlung_cents,
         sum(k.betrag_cents)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='umsatz'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='steuer'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='versand'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='gebuehren'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='werbung'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='lager'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='erstattung'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='promotion'),0)::bigint,
         coalesce(sum(k.betrag_cents) filter (where k.topf='sonstiges'),0)::bigint,
         count(*)::int
  from klassifiziert k
  left join kopf on kopf.settlement_id = k.settlement_id
  group by k.settlement_id, kopf.von, kopf.bis, kopf.auszahlung_datum, kopf.auszahlung_cents
  order by coalesce(kopf.bis, max(k.gebucht_am)) desc nulls last
$$;

revoke all on function public.abrechnungen(uuid) from public, anon, authenticated;
grant execute on function public.abrechnungen(uuid) to service_role;;

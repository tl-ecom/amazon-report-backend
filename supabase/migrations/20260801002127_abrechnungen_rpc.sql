-- Auszahlungen je Abrechnungszeitraum, aufgeschluesselt.
-- Beantwortet: Warum ist die Auszahlung kleiner als der Umsatz?
--
-- Die Kopfzeile eines Settlements traegt total-amount und hat KEINEN Betragstyp.
-- Sie ist die von Amazon genannte Auszahlungssumme — die Gegenprobe zur eigenen
-- Rechnung. Weichen beide ab, fehlt eine Position und das gehoert sichtbar.
create or replace function public.abrechnungen(p_tenant uuid)
returns table (
  settlement_id text, von date, bis date, auszahlung_datum date,
  auszahlung_cents bigint,
  umsatz_cents bigint, steuer_cents bigint, versand_cents bigint,
  gebuehren_cents bigint, werbung_cents bigint, sonstiges_cents bigint,
  positionen int
)
language sql stable security definer set search_path to 'public'
as $$
  select s.settlement_id,
         max(s.settlement_start) as von,
         max(s.settlement_end) as bis,
         max(s.auszahlung_datum) as auszahlung_datum,
         -- Kopfzeile: einzige Zeile ohne Betragstyp
         max(s.gesamtbetrag_cents) filter (where s.betrag_typ is null) as auszahlung_cents,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ = 'ItemPrice' and s.betrag_beschreibung = 'Principal'), 0) as umsatz_cents,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ = 'ItemPrice' and s.betrag_beschreibung ilike '%Tax%'), 0) as steuer_cents,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ = 'ItemPrice' and s.betrag_beschreibung ilike '%Shipping%'), 0) as versand_cents,
         coalesce(sum(s.betrag_cents) filter (where s.betrag_typ = 'ItemFees'), 0) as gebuehren_cents,
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ ilike '%Advertising%' or s.betrag_beschreibung ilike '%Advertis%'), 0) as werbung_cents,
         -- Alles Uebrige: Reserve, Rueckbelastungen, Anpassungen. Bewusst als
         -- ein Topf — einzeln aufzufaechern hilft dem Seller hier nicht.
         coalesce(sum(s.betrag_cents) filter (
           where s.betrag_typ is not null
             and s.betrag_typ not in ('ItemPrice','ItemFees')
             and s.betrag_typ not ilike '%Advertising%'), 0) as sonstiges_cents,
         count(*) filter (where s.betrag_typ is not null)::int as positionen
  from public.settlement_zeilen s
  where s.tenant_id = p_tenant and s.settlement_id is not null
  group by s.settlement_id
  order by max(s.settlement_end) desc nulls last
$$;

revoke all on function public.abrechnungen(uuid) from public, anon, authenticated;
grant execute on function public.abrechnungen(uuid) to service_role;;

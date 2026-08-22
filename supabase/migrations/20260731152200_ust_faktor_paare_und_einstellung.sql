-- Vergleichspaare für die Messung des Steuerfaktors.
-- brutto: was Amazon gebucht hat (Abrechnungsbericht, Einzelstück-Positionen)
-- netto:  was Amazon erwartet (Gebührenvorschau je SKU und Marktplatz)
-- Nur Einzelstück-Positionen, damit "je Stück" wirklich je Stück ist.
create or replace function public.ust_faktor_paare(p_tenant uuid)
returns table (sku text, brutto_cents bigint, netto_cents bigint)
language sql
security definer
set search_path = public
as $$
  select s.sku,
         (-s.betrag_cents)::bigint  as brutto_cents,
         v.fulfilment_cents         as netto_cents
  from public.settlement_zeilen s
  join public.fba_gebuehrenvorschau v
    on v.tenant_id = s.tenant_id
   and v.sku = s.sku
   -- 'Amazon.de' -> 'DE'. Dieselbe SKU hat je Marktplatz eine andere Gebuehr,
   -- ein Vergleich ueber Marktplaetze hinweg waere schlicht falsch.
   and v.marketplace = upper(split_part(s.marktplatz, '.', 2))
  where s.tenant_id = p_tenant
    and s.betrag_beschreibung = 'FBAPerUnitFulfillmentFee'
    and s.menge = 1
    and s.betrag_cents < 0
    and v.fulfilment_cents > 0
$$;

revoke all on function public.ust_faktor_paare(uuid) from public, anon, authenticated;
grant execute on function public.ust_faktor_paare(uuid) to service_role;

-- Bestaetigter Faktor je Firma. NULL = nicht bestaetigt -> es wird NICHTS
-- umgerechnet, die Gebuehren erscheinen wie gebucht.
alter table public.tenant_einstellungen
  add column if not exists gebuehren_ust_faktor numeric,
  add column if not exists gebuehren_ust_quelle text,      -- 'gemessen' | 'manuell'
  add column if not exists gebuehren_ust_bestaetigt_am timestamptz;

comment on column public.tenant_einstellungen.gebuehren_ust_faktor is
  'Bestaetigter Faktor brutto/netto fuer Amazon-Gebuehren. NULL = unbestaetigt, dann wird nicht umgerechnet. 1,0 = keine USt. (Reverse Charge, Kleinunternehmer).';;

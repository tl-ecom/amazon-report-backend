-- Der Demo-Mandant NORVIK hat erfundene, in sich stimmige Daten und BEWUSST
-- keine SP-API-/Ads-Verbindung, damit kein Sync sie ueberschreibt. Folge: Die
-- Zeitachse steht still. Am 27.08. endeten die Daten am 22.08. — "letzte 7 Tage"
-- zeigte bald nichts mehr.
--
-- Diese Funktion schreibt die Zeitachse taeglich fort: Fuer jeden fehlenden Tag
-- wird ein VERGLEICHBARER Tag kopiert — derselbe Wochentag, 28, 56 oder 84 Tage
-- zurueck, deterministisch aus dem Zieldatum gewaehlt. Warum nicht einfach immer
-- 28 Tage: Dann waere "letzte 7 Tage" exakt identisch mit den 7 Tagen vier Wochen
-- davor, und ein Zeitraumvergleich in der Demo zeigte lauter Nullen. Drei
-- moegliche Quelltage brechen den Zyklus, ohne die Stimmigkeit eines Tages
-- anzutasten: kopiert wird immer ein GANZER Tag, nie einzelne Zahlen.
--
-- Sicherung: Die Funktion arbeitet ausschliesslich auf dem Demo-Mandanten UND
-- bricht ab, sobald dieser eine echte Amazon-Verbindung hat. Sonst wuerde sie
-- eines Tages echte Kundendaten vervielfaeltigen.

create or replace function internal.demo_zeitachse_fortschreiben()
returns jsonb
language plpgsql
security definer
set search_path to 'internal', 'public'
as $$
declare
  v_tenant  uuid := 'a7f4c2e1-9b3d-4e56-8a12-6c0f5d8e3b47';
  v_bis     date := current_date - 1;   -- Amazon liefert den Vortag, nie heute
  v_ab      date;
  v_ziel    date;
  v_quelle  date;
  v_versatz int;
  v_tage    int := 0;
  v_zeilen  int := 0;
  v_summe   int := 0;
begin
  -- Notbremse: sobald der Mandant echt verbunden ist, ist er kein Demo mehr.
  if exists (select 1 from public.auth_contexts a
             where a.tenant_id = v_tenant and a.status = 'connected') then
    return jsonb_build_object('abgebrochen', 'Mandant hat eine echte Amazon-Verbindung');
  end if;

  select max(purchase_date)::date into v_ab from public.orders_history where tenant_id = v_tenant;
  if v_ab is null then
    return jsonb_build_object('abgebrochen', 'keine Ausgangsdaten vorhanden');
  end if;

  v_ziel := v_ab + 1;
  while v_ziel <= v_bis loop
    -- 28, 56 oder 84 Tage zurueck — immer derselbe Wochentag.
    v_versatz := 28 * (1 + ((hashtext(v_ziel::text) % 3) + 3) % 3);
    v_quelle := v_ziel - v_versatz;
    -- Falls dort nichts liegt, auf die naechstgelegene Quelle zurueckfallen.
    if not exists (select 1 from public.orders_history
                   where tenant_id = v_tenant and purchase_date::date = v_quelle) then
      v_quelle := v_ziel - 28;
    end if;

    -- 1) Bestellungen. Neue Order-ID, damit der Primaerschluessel traegt.
    insert into public.orders_history
      (tenant_id, amazon_order_id, sku, asin, purchase_date, quantity,
       item_price_cents, currency, sales_channel, order_status)
    select o.tenant_id,
           'DEMO-' || to_char(v_ziel,'YYYYMMDD') || '-' || substr(md5(o.amazon_order_id), 1, 10),
           o.sku, o.asin,
           o.purchase_date + (v_versatz || ' days')::interval,
           o.quantity, o.item_price_cents, o.currency, o.sales_channel, o.order_status
    from public.orders_history o
    where o.tenant_id = v_tenant and o.purchase_date::date = v_quelle
    on conflict do nothing;
    get diagnostics v_zeilen = row_count;
    v_summe := v_summe + v_zeilen;

    -- 2) Werbung.
    insert into public.ads_daily
      (tenant_id, datum, campaign_id, ad_group_id, asin, sku, campaign_name,
       impressions, clicks, spend_cents, sales_cents, orders, einheiten)
    select a.tenant_id, v_ziel, a.campaign_id, a.ad_group_id, a.asin, a.sku, a.campaign_name,
           a.impressions, a.clicks, a.spend_cents, a.sales_cents, a.orders, a.einheiten
    from public.ads_daily a
    where a.tenant_id = v_tenant and a.datum = v_quelle
    on conflict do nothing;

    -- 3) Sales & Traffic je Tag.
    insert into public.sales_daily
      (tenant_id, datum, sessions, page_views, units_ordered, total_order_items,
       units_shipped, orders_shipped, units_refunded, ordered_sales_cents,
       shipped_sales_cents, waehrung)
    select s.tenant_id, v_ziel, s.sessions, s.page_views, s.units_ordered, s.total_order_items,
           s.units_shipped, s.orders_shipped, s.units_refunded, s.ordered_sales_cents,
           s.shipped_sales_cents, s.waehrung
    from public.sales_daily s
    where s.tenant_id = v_tenant and s.datum = v_quelle
    on conflict do nothing;

    -- 4) Retouren. row_hash neu bilden, sonst kollidiert der Primaerschluessel.
    insert into public.returns_history
      (tenant_id, row_hash, return_request_date, asin, sku, item_name,
       return_quantity, refunded_cents, currency, return_reason, resolution, return_status)
    select r.tenant_id,
           md5(r.row_hash || '|' || v_ziel::text),
           v_ziel, r.asin, r.sku, r.item_name,
           r.return_quantity, r.refunded_cents, r.currency,
           r.return_reason, r.resolution, r.return_status
    from public.returns_history r
    where r.tenant_id = v_tenant and r.return_request_date = v_quelle
    on conflict do nothing;

    v_tage := v_tage + 1;
    v_ziel := v_ziel + 1;
  end loop;

  -- Nach hinten begrenzen, damit die Demo nicht unbegrenzt waechst.
  delete from public.orders_history
   where tenant_id = v_tenant and purchase_date < (current_date - 400);
  delete from public.ads_daily
   where tenant_id = v_tenant and datum < (current_date - 400);
  delete from public.sales_daily
   where tenant_id = v_tenant and datum < (current_date - 400);
  delete from public.returns_history
   where tenant_id = v_tenant and return_request_date < (current_date - 400);

  return jsonb_build_object('tage', v_tage, 'bestellzeilen', v_summe, 'bis', v_bis);
end $$;

revoke all on function internal.demo_zeitachse_fortschreiben() from public, anon, authenticated;

-- Aufraeumen: 20 Retouren lagen in der Zukunft (der Generator hat die Retoure N
-- Tage nach dem Kauf angesetzt, ohne bei heute zu stoppen). In der Retourenliste
-- standen sie ganz oben.
delete from public.returns_history
where tenant_id = 'a7f4c2e1-9b3d-4e56-8a12-6c0f5d8e3b47'
  and return_request_date > current_date;;

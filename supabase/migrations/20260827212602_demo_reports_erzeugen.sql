-- Fuenf MCP-Werkzeuge lesen aus report_data statt aus den Verlaufstabellen:
-- get_sales_overview, get_orders_overview, get_listings_overview,
-- get_returns_overview, get_ads_overview. Beim Demo-Mandanten war report_data
-- leer — die fuenf lieferten nichts, was in einer Vorfuehrung wie ein kaputtes
-- Werkzeug aussieht.
--
-- Diese Funktion baut die Nutzlasten aus den vorhandenen Verlaufsdaten, in
-- exakt der Form, die die Auswertungen erwarten (abgeschaut an Vanejas echten
-- Reports, nicht aus dem Parser-Code erraten).
--
-- Der heikle Punkt: `pruefeKonsistenz` in metrics.ts vergleicht die Summen NACH
-- DATUM gegen die NACH ASIN und meldet Abweichungen offen. Beide Granularitaeten
-- werden deshalb aus DERSELBEN Zeilenmenge abgeleitet. Sessions und Seitenaufrufe
-- gibt es nur je Tag; sie werden anteilig auf die ASINs verteilt und der
-- Rundungsrest der groessten ASIN zugeschlagen, damit die Summe exakt stimmt.
--
-- is_provisional = false: Die Daten sind erfunden und damit endgueltig; ein
-- "wird von Amazon noch angepasst" waere hier eine Unwahrheit.

create or replace function internal.demo_reports_erzeugen()
returns jsonb
language plpgsql
security definer
set search_path to 'internal', 'public'
as $$
declare
  v_tenant uuid := 'a7f4c2e1-9b3d-4e56-8a12-6c0f5d8e3b47';
  v_bis  date := current_date - 1;
  v_von  date := current_date - 30;
  v_stand timestamptz := (current_date)::timestamptz + interval '4 hours 30 minutes';
  v_payload jsonb;
  v_anz jsonb := '{}'::jsonb;
begin
  if exists (select 1 from public.auth_contexts a
             where a.tenant_id = v_tenant and a.status = 'connected') then
    return jsonb_build_object('abgebrochen', 'Mandant hat eine echte Amazon-Verbindung');
  end if;

  -- ---------- 1) Sales & Traffic ----------
  with basis as (
    select o.asin, o.purchase_date::date as tag, o.quantity, o.item_price_cents
    from public.orders_history o
    where o.tenant_id = v_tenant and o.asin is not null
      and o.purchase_date::date between v_von and v_bis
      and coalesce(o.order_status,'') not ilike '%cancel%'
  ),
  ret as (
    select r.asin, r.return_request_date as tag, coalesce(r.return_quantity,0) as menge
    from public.returns_history r
    where r.tenant_id = v_tenant and r.return_request_date between v_von and v_bis
  ),
  sd as (
    select s.datum, coalesce(s.sessions,0) as sessions, coalesce(s.page_views,0) as page_views
    from public.sales_daily s
    where s.tenant_id = v_tenant and s.datum between v_von and v_bis
  ),
  traffic as (select coalesce(sum(sessions),0)::bigint s, coalesce(sum(page_views),0)::bigint p from sd),
  je_tag as (
    select tag, sum(quantity)::bigint units, count(*)::bigint items, sum(item_price_cents)::bigint cents
    from basis group by tag
  ),
  ret_tag as (select tag, sum(menge)::bigint u from ret group by tag),
  je_asin as (
    select asin, sum(quantity)::bigint units, count(*)::bigint items, sum(item_price_cents)::bigint cents
    from basis group by asin
  ),
  ret_asin as (select asin, sum(menge)::bigint u from ret group by asin),
  gesamt as (select coalesce(sum(units),0)::bigint units from je_asin),
  alloc as (
    select a.asin, a.units, a.items, a.cents,
           floor(t.s * a.units::numeric / nullif(g.units,0))::bigint as sess,
           floor(t.p * a.units::numeric / nullif(g.units,0))::bigint as pv,
           row_number() over (order by a.units desc, a.asin) as rn
    from je_asin a cross join traffic t cross join gesamt g
  ),
  korr as (
    select (select s from traffic) - coalesce(sum(sess),0) as ds,
           (select p from traffic) - coalesce(sum(pv),0)  as dp
    from alloc
  ),
  nach_datum as (
    select jsonb_agg(jsonb_build_object(
      'date', sd.datum::text,
      'salesByDate', jsonb_build_object(
        'unitsOrdered', coalesce(t.units,0),
        'totalOrderItems', coalesce(t.items,0),
        'unitsShipped', coalesce(t.units,0),
        'ordersShipped', coalesce(t.items,0),
        'unitsRefunded', coalesce(rt.u,0),
        'orderedProductSales', jsonb_build_object('amount', round(coalesce(t.cents,0)/100.0, 2), 'currencyCode','EUR'),
        'shippedProductSales', jsonb_build_object('amount', round(coalesce(t.cents,0)/100.0, 2), 'currencyCode','EUR'),
        'averageSellingPrice', jsonb_build_object(
            'amount', case when coalesce(t.units,0) > 0 then round(t.cents/100.0/t.units, 2) else 0 end,
            'currencyCode','EUR')
      ),
      'trafficByDate', jsonb_build_object(
        'sessions', sd.sessions, 'pageViews', sd.page_views,
        'buyBoxPercentage', 98.5,
        'unitSessionPercentage',
          case when sd.sessions > 0 then round(coalesce(t.units,0)*100.0/sd.sessions, 2) else 0 end
      )
    ) order by sd.datum) as j
    from sd left join je_tag t on t.tag = sd.datum left join ret_tag rt on rt.tag = sd.datum
  ),
  nach_asin as (
    select jsonb_agg(jsonb_build_object(
      'childAsin', a.asin, 'parentAsin', a.asin,
      'salesByAsin', jsonb_build_object(
        'unitsOrdered', a.units,
        'totalOrderItems', a.items,
        'unitsShipped', a.units,
        'ordersShipped', a.items,
        'unitsRefunded', coalesce(ra.u,0),
        'orderedProductSales', jsonb_build_object('amount', round(a.cents/100.0, 2), 'currencyCode','EUR'),
        'shippedProductSales', jsonb_build_object('amount', round(a.cents/100.0, 2), 'currencyCode','EUR')
      ),
      'trafficByAsin', jsonb_build_object(
        'sessions', a.sess + case when a.rn = 1 then k.ds else 0 end,
        'pageViews', a.pv   + case when a.rn = 1 then k.dp else 0 end,
        'buyBoxPercentage', 98.5
      )
    ) order by a.units desc) as j
    from alloc a cross join korr k left join ret_asin ra on ra.asin = a.asin
  )
  select jsonb_build_object(
    'reportSpecification', jsonb_build_object(
        'reportType','GET_SALES_AND_TRAFFIC_REPORT',
        'dataStartTime', v_von::text, 'dataEndTime', v_bis::text,
        'marketplaceIds', jsonb_build_array('A1PA6795UKMFR9')),
    'salesAndTrafficByDate', coalesce((select j from nach_datum), '[]'::jsonb),
    'salesAndTrafficByAsin', coalesce((select j from nach_asin), '[]'::jsonb))
  into v_payload;

  perform internal.demo_report_setzen(v_tenant, 'sp', 'GET_SALES_AND_TRAFFIC_REPORT', v_payload, v_stand);
  v_anz := v_anz || jsonb_build_object('sales_tage', jsonb_array_length(v_payload->'salesAndTrafficByDate'),
                                       'sales_asins', jsonb_array_length(v_payload->'salesAndTrafficByAsin'));

  -- ---------- 2) Bestellungen (Flat File) ----------
  select jsonb_build_object(
    'format','tsv', 'encoding','utf-8',
    'header', to_jsonb(array['amazon-order-id','merchant-order-id','purchase-date','last-updated-date',
      'order-status','fulfillment-channel','sales-channel','order-channel','ship-service-level',
      'product-name','sku','asin','item-status','quantity','currency','item-price','item-tax',
      'shipping-price','shipping-tax','gift-wrap-price','gift-wrap-tax','item-promotion-discount',
      'ship-promotion-discount','ship-country','promotion-ids','is-business-order',
      'purchase-order-number','price-designation','is-iba','order-item-id']),
    'rowCount', count(*),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
        'amazon-order-id', o.amazon_order_id,
        'merchant-order-id', o.amazon_order_id,
        'purchase-date', to_char(o.purchase_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'last-updated-date', to_char(o.purchase_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'order-status', coalesce(o.order_status,'Shipped'),
        'fulfillment-channel', 'Amazon',
        'sales-channel', coalesce(o.sales_channel,'Amazon.de'),
        'order-channel', '',
        'ship-service-level', 'Standard',
        'product-name', coalesce(g.produktname, o.sku),
        'sku', o.sku, 'asin', coalesce(o.asin,''),
        'item-status', coalesce(o.order_status,'Shipped'),
        'quantity', o.quantity::text,
        'currency', coalesce(o.currency,'EUR'),
        'item-price', to_char(o.item_price_cents/100.0, 'FM9999990.00'),
        'item-tax','0.00','shipping-price','0.00','shipping-tax','0.00',
        'gift-wrap-price','0.00','gift-wrap-tax','0.00',
        'item-promotion-discount','0.00','ship-promotion-discount','0.00',
        'ship-country','DE','promotion-ids','','is-business-order','false',
        'purchase-order-number','','price-designation','','is-iba','false',
        'order-item-id', substr(md5(o.amazon_order_id || o.sku), 1, 14)
      ) order by o.purchase_date), '[]'::jsonb))
  into v_payload
  from public.orders_history o
  left join public.fba_gebuehrenvorschau g on g.tenant_id = o.tenant_id and g.sku = o.sku
  where o.tenant_id = v_tenant and o.purchase_date::date between v_von and v_bis;

  perform internal.demo_report_setzen(v_tenant, 'sp', 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', v_payload, v_stand);
  v_anz := v_anz || jsonb_build_object('bestellzeilen', v_payload->'rowCount');

  -- ---------- 3) Angebote ----------
  select jsonb_build_object(
    'format','tsv','encoding','utf-8',
    'header', to_jsonb(array['item-name','item-description','listing-id','seller-sku','price','quantity',
      'open-date','image-url','item-is-marketplace','product-id-type','zshop-shipping-fee','item-note',
      'item-condition','zshop-category1','zshop-browse-path','zshop-storefront-feature','asin1','asin2',
      'asin3','will-ship-internationally','expedited-shipping','zshop-boldface','product-id',
      'bid-for-featured-placement','add-delete','pending-quantity','fulfillment-channel',
      'merchant-shipping-group','status','Minimum order quantity','Sell remainder']),
    'rowCount', count(*),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
        'item-name', coalesce(g.produktname, g.sku),
        'item-description','', 'listing-id', substr(md5(g.sku),1,14),
        'seller-sku', g.sku,
        'price', to_char(coalesce(g.verkaufspreis_cents, g.preis_cents, 0)/100.0, 'FM9999990.00'),
        'quantity', coalesce(b.menge, 0)::text,
        'open-date','2025-09-01','image-url','','item-is-marketplace','y',
        'product-id-type','1','zshop-shipping-fee','','item-note','','item-condition','11',
        'zshop-category1','','zshop-browse-path','','zshop-storefront-feature','',
        'asin1', coalesce(g.asin,''), 'asin2','','asin3','',
        'will-ship-internationally','','expedited-shipping','','zshop-boldface','',
        'product-id', coalesce(g.asin,''), 'bid-for-featured-placement','','add-delete','',
        'pending-quantity','0','fulfillment-channel','AMAZON_EU',
        'merchant-shipping-group','Migrated Template','status','Active',
        'Minimum order quantity','','Sell remainder','')
      order by g.sku), '[]'::jsonb))
  into v_payload
  from public.fba_gebuehrenvorschau g
  left join public.fba_bestand b on b.tenant_id = g.tenant_id and b.sku = g.sku
  where g.tenant_id = v_tenant;

  perform internal.demo_report_setzen(v_tenant, 'sp', 'GET_MERCHANT_LISTINGS_ALL_DATA', v_payload, v_stand);
  v_anz := v_anz || jsonb_build_object('angebote', v_payload->'rowCount');

  -- ---------- 4) Retouren ----------
  select jsonb_build_object(
    'format','tsv','encoding','utf-8',
    'header', to_jsonb(array['Order ID','Order date','Return request date','Return request status',
      'Amazon RMA ID','Merchant RMA ID','Label type','Label cost','Currency code','Return carrier',
      'Tracking ID','Label to be paid by','A-to-Z Claim','Is prime','ASIN','Merchant SKU','Item Name',
      'Return quantity','Return Reason','In policy','Return type','Resolution','Invoice number',
      'Return delivery date','Order Amount','Order quantity','SafeT Action reason','SafeT claim id',
      'SafeT claim state','SafeT claim creation time','SafeT claim reimbursement amount',
      'Refunded Amount','Category','VAT','Order Item ID']),
    'rowCount', count(*),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
        'Order ID', 'DEMO-' || substr(r.row_hash,1,12),
        'Order date', (r.return_request_date - 4)::text,
        'Return request date', r.return_request_date::text,
        'Return request status', coalesce(r.return_status,'Completed'),
        'Amazon RMA ID', substr(r.row_hash,1,10), 'Merchant RMA ID','',
        'Label type','','Label cost','0.00','Currency code', coalesce(r.currency,'EUR'),
        'Return carrier','','Tracking ID','','Label to be paid by','','A-to-Z Claim','false',
        'Is prime','true','ASIN', coalesce(r.asin,''), 'Merchant SKU', coalesce(r.sku,''),
        'Item Name', coalesce(r.item_name,''),
        'Return quantity', coalesce(r.return_quantity,0)::text,
        'Return Reason', coalesce(r.return_reason,''),
        'In policy','Y','Return type','','Resolution', coalesce(r.resolution,''),
        'Invoice number','','Return delivery date','',
        'Order Amount', to_char(coalesce(r.refunded_cents,0)/100.0,'FM9999990.00'),
        'Order quantity', coalesce(r.return_quantity,0)::text,
        'SafeT Action reason','','SafeT claim id','','SafeT claim state','',
        'SafeT claim creation time','','SafeT claim reimbursement amount','',
        'Refunded Amount', to_char(coalesce(r.refunded_cents,0)/100.0,'FM9999990.00'),
        'Category','','VAT','','Order Item ID', substr(r.row_hash,13,14))
      order by r.return_request_date), '[]'::jsonb))
  into v_payload
  from public.returns_history r
  where r.tenant_id = v_tenant and r.return_request_date between v_von and v_bis;

  perform internal.demo_report_setzen(v_tenant, 'sp', 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE', v_payload, v_stand);
  v_anz := v_anz || jsonb_build_object('retouren', v_payload->'rowCount');

  -- ---------- 5) Werbung ----------
  -- cost und sales7d sind EURO, nicht Cent (AdsAkku rechnet x100).
  select jsonb_build_object(
    'format','ads_v3',
    'rows', coalesce(jsonb_agg(jsonb_build_object(
        'date', a.datum::text,
        'campaignId', a.campaign_id, 'campaignName', coalesce(a.campaign_name,''),
        'adGroupId', a.ad_group_id,
        'advertisedSku', coalesce(a.sku,''), 'advertisedAsin', coalesce(a.asin,''),
        'impressions', coalesce(a.impressions,0), 'clicks', coalesce(a.clicks,0),
        'cost', round(coalesce(a.spend_cents,0)/100.0, 2),
        'sales7d', round(coalesce(a.sales_cents,0)/100.0, 2),
        'purchases7d', coalesce(a.orders,0),
        'unitsSoldClicks7d', coalesce(a.einheiten,0))
      order by a.datum), '[]'::jsonb))
  into v_payload
  from public.ads_daily a
  where a.tenant_id = v_tenant and a.datum between v_von and v_bis;

  perform internal.demo_report_setzen(v_tenant, 'ads', 'sp-advertised-product', v_payload, v_stand);
  v_anz := v_anz || jsonb_build_object('ads_zeilen', jsonb_array_length(v_payload->'rows'));

  return v_anz || jsonb_build_object('von', v_von, 'bis', v_bis);
end $$;

-- Hilfsfunktion: eine Report-Zeile ersetzen (is_latest bleibt eindeutig).
create or replace function internal.demo_report_setzen(
  p_tenant uuid, p_source text, p_type text, p_payload jsonb, p_stand timestamptz)
returns void
language sql
security definer
set search_path to 'internal', 'public'
as $$
  with weg as (
    delete from public.report_data
     where tenant_id = p_tenant and source = p_source and report_type = p_type
  )
  insert into public.report_data
    (tenant_id, source, report_type, payload, data_timestamp, is_provisional, is_latest)
  values (p_tenant, p_source, p_type, p_payload, p_stand, false, true);
$$;

revoke all on function internal.demo_reports_erzeugen() from public, anon, authenticated;
revoke all on function internal.demo_report_setzen(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;;

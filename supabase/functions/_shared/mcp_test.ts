// Tests für mcp.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/

import { assertEquals } from "jsr:@std/assert@1";
import { dispatch, McpContext, toolListe } from "./mcp.ts";

// Fake-Loader: liefert vorgegebene Payloads, ohne DB. Genau dafür ist ctx da.
function ctxMit(daten: Record<string, any>): McpContext {
  return {
    ladeReport: (typ) =>
      Promise.resolve(daten[typ] ? { payload: daten[typ], data_timestamp: "2026-07-17T00:00:00Z", is_provisional: false } : null),
  };
}

const leererCtx: McpContext = { ladeReport: () => Promise.resolve(null) };

/**
 * Tool-Daten aus einem tools/call-Ergebnis. Sie stehen als JSON im Text-Content —
 * absichtlich NICHT in structuredContent (siehe Kommentar in mcp.ts).
 */
function toolDaten(r: any): any {
  return JSON.parse(r.result.content[0].text);
}

const salesPayload = {
  reportSpecification: { dataStartTime: "2026-07-01", dataEndTime: "2026-07-15" },
  salesAndTrafficByDate: [
    {
      date: "2026-07-01",
      salesByDate: { unitsOrdered: 2, totalOrderItems: 2, orderedProductSales: { amount: 20, currencyCode: "EUR" }, shippedProductSales: { amount: 20, currencyCode: "EUR" }, unitsShipped: 2, unitsRefunded: 0, ordersShipped: 2 },
      trafficByDate: { sessions: 100, pageViews: 120, unitSessionPercentage: 2 },
    },
  ],
  salesAndTrafficByAsin: [
    { childAsin: "B001", parentAsin: "P1", salesByAsin: { unitsOrdered: 2, totalOrderItems: 2, orderedProductSales: { amount: 20, currencyCode: "EUR" }, shippedProductSales: { amount: 20, currencyCode: "EUR" }, unitsShipped: 2, unitsRefunded: 0, ordersShipped: 2 }, trafficByAsin: { sessions: 100, pageViews: 120 } },
  ],
};

const ordersPayload = {
  format: "tsv",
  rows: [
    { "amazon-order-id": "028-1", asin: "B001", quantity: "1", "item-price": "10.00", currency: "EUR", "sales-channel": "Amazon.de", "order-status": "Shipped", "purchase-date": "2026-07-03T00:00:00Z" },
  ],
};

// --- initialize ---
Deno.test("initialize spiegelt eine bekannte Protokollversion zurueck", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, leererCtx);
  assertEquals(r!.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "amazon-report-backend", version: "0.1.0" },
  });
});

Deno.test("initialize faellt bei unbekannter Version auf die neueste zurueck", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, leererCtx);
  assertEquals((r!.result as any).protocolVersion, "2025-11-25");
});

// --- notifications ---
Deno.test("notifications erzeugen KEINE Antwort", async () => {
  const r = await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, leererCtx);
  assertEquals(r, null);
});

// --- ping ---
Deno.test("ping antwortet leer", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 7, method: "ping" }, leererCtx);
  assertEquals(r, { jsonrpc: "2.0", id: 7, result: {} });
});

// --- tools/list ---
Deno.test("tools/list nennt alle Tools mit Schema", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, leererCtx);
  const tools = (r!.result as any).tools;
  assertEquals(tools.map((t: any) => t.name), [
    "get_sales_overview", "get_orders_overview", "get_listings_overview", "get_product_performance",
    "get_returns_overview", "get_ads_overview", "get_ads_verlauf",
    "get_ads_struktur", "get_ads_suchbegriffe", "get_ads_platzierungen",
    "get_sales_history", "get_orders_history", "get_orders_revenue",
    "get_returns_history",
    "get_products", "get_kpi_history", "get_profit_history", "get_search_query_performance",
    "get_diagnoses", "get_change_log", "get_strategy_overview",
  ]);
  // Jedes Tool MUSS ein inputSchema haben, sonst lehnen manche Clients es ab.
  for (const t of tools) assertEquals(typeof t.inputSchema, "object");
});

Deno.test("toolListe ist stabil", () => {
  assertEquals(toolListe().length, 21);
});

Deno.test("Pulse-Tools rufen ladePulse mit der richtigen Datenart", async () => {
  const gerufen: string[] = [];
  const ctx = {
    ladeReport: async () => null,
    ladePulse: async (art: string) => { gerufen.push(art); return { ok: art }; },
  } as any;
  const paare: Array<[string, string]> = [
    ["get_products", "produkte"], ["get_kpi_history", "kpi"], ["get_profit_history", "ertrag"],
    ["get_search_query_performance", "sqp"], ["get_diagnoses", "diagnosen"],
    ["get_change_log", "aenderungen"], ["get_strategy_overview", "strategie"],
    ["get_ads_verlauf", "ads_verlauf"],
    ["get_ads_struktur", "ads_struktur"], ["get_ads_suchbegriffe", "ads_suchbegriffe"],
    ["get_ads_platzierungen", "ads_platzierungen"],
  ];
  for (const [tool, art] of paare) {
    await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }, ctx);
    assertEquals(gerufen.at(-1), art);
  }
});

Deno.test("get_ads_overview liest source='ads' und rechnet ACOS", async () => {
  const ctx = {
    ladeReport: (typ: string, source = "sp") => {
      // Das Ads-Tool MUSS mit source='ads' laden, nicht 'sp'.
      if (typ === "sp-advertised-product" && source === "ads") {
        return Promise.resolve({
          payload: { format: "ads_v3", rows: [{ campaignId: "C1", campaignName: "K", advertisedAsin: "B1", impressions: 1000, clicks: 50, cost: 25, sales7d: 100, purchases7d: 5, unitsSoldClicks7d: 5, date: "2026-07-01" }] },
          data_timestamp: "2026-07-17T00:00:00Z",
          is_provisional: false,
        });
      }
      return Promise.resolve(null);
    },
  };
  const r = await dispatch(
    { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "get_ads_overview", arguments: {} } },
    ctx
  );
  const sc = toolDaten(r);
  assertEquals(sc.gesamt.spend, 25);
  assertEquals(sc.gesamt.sales, 100);
  assertEquals(sc.gesamt.acos, 25); // 25/100
});

Deno.test("get_ads_overview meldet keine_daten, wenn source='sp' statt 'ads' geliefert wuerde", async () => {
  // Absicherung: das Tool darf NICHT versehentlich den sp-Report nehmen.
  const ctx = {
    ladeReport: (_typ: string, source = "sp") =>
      Promise.resolve(source === "sp" ? { payload: { rows: [] }, data_timestamp: "x", is_provisional: false } : null),
  };
  const r = await dispatch(
    { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "get_ads_overview", arguments: {} } },
    ctx
  );
  const sc = toolDaten(r);
  assertEquals(sc.keine_daten, true);
});

Deno.test("get_product_performance fuehrt die drei Quellen zusammen, getrennt", async () => {
  const ctx = {
    ladeReport: (typ: string) => {
      const daten: Record<string, any> = {
        GET_SALES_AND_TRAFFIC_REPORT: {
          reportSpecification: { dataStartTime: "2026-04-16", dataEndTime: "2026-07-15", marketplaceIds: ["A1PA6795UKMFR9"] },
          salesAndTrafficByAsin: [{ childAsin: "B0DNT2FDN9", salesByAsin: { unitsOrdered: 6, orderedProductSales: { amount: 48.12 } }, trafficByAsin: { sessions: 35 } }],
        },
        GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL: {
          format: "tsv",
          rows: [{ "amazon-order-id": "1", asin: "B0DNT2FDN9", quantity: "1", "item-price": "7.85", "sales-channel": "Amazon.de" }],
        },
      };
      return Promise.resolve(daten[typ] ? { payload: daten[typ], data_timestamp: "2026-07-17T00:00:00Z", is_provisional: false } : null);
    },
  };
  const r = await dispatch(
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_product_performance", arguments: { asin: "B0DNT2FDN9" } } },
    ctx
  );
  const sc = toolDaten(r);
  assertEquals(sc.produkte.length, 1);
  assertEquals(sc.produkte[0].sales_traffic.unitsOrdered, 6);
  assertEquals(sc.produkte[0].orders.bestellungen, 1);
  assertEquals(sc.warnung.includes("NICHT"), true);
});

// --- tools/call: Erfolg ---
Deno.test("get_sales_overview liefert gerechnete Kennzahlen", async () => {
  const r = await dispatch(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_sales_overview", arguments: {} } },
    ctxMit({ GET_SALES_AND_TRAFFIC_REPORT: salesPayload })
  );
  const res = r!.result as any;
  assertEquals(res.isError, false);
  // strukturiert UND als Text.
  assertEquals(toolDaten(r).gesamt.sessions, 100);
  assertEquals(toolDaten(r).gesamt.cvrUnitSession, 2); // 2/100
  const ausText = JSON.parse(res.content[0].text);
  assertEquals(ausText.gesamt.umsatzOrdered, 20);
});

Deno.test("get_orders_overview liefert Bestell-Kennzahlen", async () => {
  const r = await dispatch(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_orders_overview", arguments: {} } },
    ctxMit({ GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL: ordersPayload })
  );
  const res = r!.result as any;
  assertEquals(res.isError, false);
  assertEquals(toolDaten(r).gesamt.bestellungen, 1);
  assertEquals(toolDaten(r).gesamt.umsatz, 10);
});

Deno.test("get_listings_overview liefert Bestands-Kennzahlen", async () => {
  const listingsPayload = {
    format: "tsv",
    rows: [
      { status: "Active", "fulfillment-channel": "DEFAULT", quantity: "0", price: "5.00", "seller-sku": "S1", asin1: "B1", "item-name": "X" },
      { status: "Active", "fulfillment-channel": "AMAZON_EU", quantity: "", price: "9.00", "seller-sku": "S2", asin1: "B2", "item-name": "Y" },
      { status: "Inactive", "fulfillment-channel": "DEFAULT", quantity: "3", price: "4.00", "seller-sku": "S3", asin1: "B3", "item-name": "Z" },
    ],
  };
  const r = await dispatch(
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "get_listings_overview", arguments: {} } },
    ctxMit({ GET_MERCHANT_LISTINGS_ALL_DATA: listingsPayload })
  );
  const sc = toolDaten(r);
  assertEquals(sc.gesamt.aktiv, 2);
  assertEquals(sc.bestand_merchant.ausverkauft, 1); // nur das Merchant-Angebot mit qty 0
  assertEquals(sc.bestand_fba.aktive_angebote, 1);
});

// --- tools/call: keine Daten ist KEIN Fehler ---
Deno.test("fehlende Daten sind kein Protokollfehler, sondern ein Hinweis", async () => {
  const r = await dispatch(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_sales_overview", arguments: {} } },
    leererCtx
  );
  const res = r!.result as any;
  assertEquals(res.isError, false);
  assertEquals(toolDaten(r).keine_daten, true);
});

// --- tools/call: Ergebnisform ---
Deno.test("tools/call sendet KEIN structuredContent (kein Tool deklariert ein outputSchema)", async () => {
  // Regressionsschutz: unangekuendigtes structuredContent laesst strenge
  // MCP-Clients den Aufruf verwerfen, obwohl der Server mit 200 antwortet.
  const r = await dispatch(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_sales_overview", arguments: {} } },
    ctxMit({ GET_SALES_AND_TRAFFIC_REPORT: salesPayload })
  );
  const res = r!.result as any;
  assertEquals("structuredContent" in res, false);
  assertEquals(res.content[0].type, "text");
  // kein Tool darf ein outputSchema haben, solange wir structuredContent weglassen
  assertEquals(toolListe().some((t: any) => t.outputSchema), false);
});

// --- tools/call: unbekanntes Tool ---
Deno.test("unbekanntes Tool ergibt JSON-RPC-Fehler -32602", async () => {
  const r = await dispatch(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "gibts_nicht", arguments: {} } },
    leererCtx
  );
  assertEquals(r!.error?.code, -32602);
});

// --- tools/call: Tool wirft → isError, kein Protokollfehler ---
Deno.test("ein werfendes Tool wird als isError gemeldet, nicht als JSON-RPC-Fehler", async () => {
  const kaputterCtx: McpContext = {
    ladeReport: () => Promise.reject(new Error("DB weg")),
  };
  const r = await dispatch(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_sales_overview", arguments: {} } },
    kaputterCtx
  );
  const res = r!.result as any;
  assertEquals(res.isError, true);
  assertEquals(res.content[0].text.includes("DB weg"), true);
  assertEquals(r!.error, undefined); // KEIN Protokollfehler
});

// --- unbekannte Methode ---
Deno.test("unbekannte Methode ergibt -32601", async () => {
  const r = await dispatch({ jsonrpc: "2.0", id: 9, method: "voll/unbekannt" }, leererCtx);
  assertEquals(r!.error?.code, -32601);
});

// --- gemischte Währungen: das Tool meldet isError, der Server bleibt stehen ---
Deno.test("ein Rechenfehler im Tool bringt den Dispatch nicht zum Absturz", async () => {
  const mischwaehrung = {
    format: "tsv",
    rows: [
      { "amazon-order-id": "1", "item-price": "10", currency: "EUR", quantity: "1" },
      { "amazon-order-id": "2", "item-price": "10", currency: "USD", quantity: "1" },
    ],
  };
  const r = await dispatch(
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_orders_overview", arguments: {} } },
    ctxMit({ GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL: mischwaehrung })
  );
  const res = r!.result as any;
  assertEquals(res.isError, true);
  assertEquals(res.content[0].text.includes("Währung"), true);
});

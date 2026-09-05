// mcp.ts — protokoll-stabiler Kern des MCP-Servers (JSON-RPC 2.0).
//
// Reines Modul: kein Netz, keine DB. Der Zugriff auf report_data wird als
// `ladeReport`-Funktion INJIZIERT (ctx.ladeReport). Damit ist der ganze
// Dispatch unit-testbar, ohne Supabase.
//
// STATELESS mit Absicht: kein initialize-Handshake-Zwang, keine Session-ID.
// Die MCP-Spec bewegt sich genau dorthin (Release Candidate 2026-07-28 entfernt
// Session-IDs), und Edge Functions sind pro Aufruf ohnehin zustandslos. Jede
// JSON-RPC-Request steht für sich.
//
// Die eigentliche Rechenlogik kommt aus metrics.ts / orders.ts — hier wird NICHT
// neu gerechnet, nur als MCP-Tool exponiert (so wie es die Architektur vorsieht).

import { baueOverview } from "./metrics.ts";
import { baueOrdersOverview } from "./orders.ts";
import { baueListingsOverview } from "./listings.ts";
import { baueProductPerformance, Quelle } from "./product.ts";
import { baueReturnsOverview } from "./returns.ts";
import { baueAdsOverview } from "./ads.ts";

// Vom Server nach außen gemeldete Protokollversionen (neueste zuerst).
// Beim initialize wird die vom Client angeforderte zurückgespiegelt, wenn wir
// sie kennen — sonst unsere neueste.
const UNTERSTUETZTE_VERSIONEN = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "amazon-report-backend", version: "0.1.0" };

const SALES_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";
const ORDERS_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
const LISTINGS_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const RETURNS_TYPE = "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE";

export interface ReportRow {
  payload: unknown;
  data_timestamp: string;
  is_provisional: boolean;
}

export interface McpContext {
  /**
   * Liest die is_latest-Zeile eines Report-Typs für DIESEN Tenant. null = keine
   * Daten. source default 'sp'; 'ads' für die Advertising-Reports.
   */
  ladeReport: (reportType: string, source?: string) => Promise<ReportRow | null>;
  /**
   * Aggregiert die Verlaufs-Tabellen über einen Zeitraum (art: sales|orders|
   * returns, args: { von?, bis? } als 'YYYY-MM-DD'). Optional — nur api/mcp
   * verdrahten es (mit DB-Zugriff); im Unit-Test bleibt es undefined.
   */
  ladeVerlauf?: (art: "sales" | "orders" | "returns" | "orders_umsatz", args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Liest die Pulse-Analytics (art: produkte|kpi|ertrag|sqp|diagnosen|aenderungen|
   * strategie). READ-ONLY. Optional — nur mcp/api verdrahten es (mit DB-Zugriff);
   * im Unit-Test bleibt es undefined. Schreib-Aktionen gibt es hier bewusst NICHT.
   */
  ladePulse?: (art: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
}

const LEERES_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

const ZEITRAUM_SCHEMA = {
  type: "object",
  properties: {
    von: { type: "string", description: "Startdatum 'YYYY-MM-DD' (inklusiv). Default: vor 90 Tagen." },
    bis: { type: "string", description: "Enddatum 'YYYY-MM-DD' (inklusiv). Default: heute." },
  },
  additionalProperties: false,
};

const TOOLS: ToolDef[] = [
  {
    name: "get_sales_overview",
    description:
      "Deterministisch gerechnete Sales-&-Traffic-Kennzahlen des Sellers (Umsatz, " +
      "Sessions, Conversion-Rate, Durchschnittspreis, je ASIN). Aus den Rohwerten " +
      "gerechnet, nicht aus Amazons Prozentspalten. Deckt EINEN Marktplatz ab. " +
      "Enthält data_timestamp, is_provisional und die verwendeten Formeln. " +
      "ACHTUNG: nur der aktuelle Bericht (~letzte Wochen) — für ältere Zeiträume/24 Monate get_sales_history nutzen.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => {
      const row = await ctx.ladeReport(SALES_TYPE);
      if (!row) return keineDaten(SALES_TYPE);
      return baueOverview(row.payload as Record<string, any>, row.data_timestamp, row.is_provisional);
    },
  },
  {
    name: "get_orders_overview",
    description:
      "Deterministisch gerechnete Bestell-Kennzahlen (Bestellungen, Einheiten, " +
      "Umsatz je Kanal/ASIN/Status). Enthält MEHRERE Vertriebskanäle inkl. " +
      "Multi-Channel-Fulfillment — NICHT mit get_sales_overview vergleichen. " +
      "Leere Preise bedeuten 'unbekannt', nicht 0; das steht in umsatzVollstaendig " +
      "und warnungen. Enthält data_timestamp und die verwendeten Formeln. " +
      "ACHTUNG: nur der aktuelle Bericht (~letzte Wochen) — für ältere Zeiträume/24 Monate get_orders_history nutzen.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => {
      const row = await ctx.ladeReport(ORDERS_TYPE);
      if (!row) return keineDaten(ORDERS_TYPE);
      return baueOrdersOverview(row.payload as Record<string, any>, row.data_timestamp, row.is_provisional);
    },
  },
  {
    name: "get_listings_overview",
    description:
      "Momentaufnahme aller Angebote des Sellers: Anzahl nach Status (aktiv/inaktiv), " +
      "aktive Angebote nach Fulfillment (Merchant/FBA), Preisspanne, und vor allem " +
      "Out-of-Stock: aktive MERCHANT-Angebote mit Bestand 0 (die live sind, aber " +
      "nichts verkaufen können). WICHTIG: Der FBA-Lagerbestand steht NICHT hier — " +
      "FBA-Angebote führen ihre Menge in einem separaten Report. Preise sind Zahlen " +
      "ohne Währung (Marktplatz-abhängig, DE = EUR).",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => {
      const row = await ctx.ladeReport(LISTINGS_TYPE);
      if (!row) return keineDaten(LISTINGS_TYPE);
      return baueListingsOverview(row.payload as Record<string, any>, row.data_timestamp);
    },
  },
  {
    name: "get_product_performance",
    description:
      "Steckbrief je ASIN, der die drei Quellen ZUSAMMENFÜHRT, aber getrennt hält: " +
      "Sales & Traffic (Sessions/Umsatz, EIN Marktplatz, sein Zeitraum), Bestellungen " +
      "(mehrere Kanäle, anderer Zeitraum) und Angebot/Bestand (Momentaufnahme). WICHTIG: " +
      "Die Quellen decken verschiedene Zeiträume/Kanäle ab und dürfen NICHT zu einer " +
      "Gesamtzahl addiert werden — jede ist einzeln mit Herkunft ausgewiesen. Liefert " +
      "deterministische Hinweise (z.B. Traffic ohne Verkauf, nur über Fremdkanäle " +
      "verkauft, Out-of-Stock). Optional 'asin' für ein Produkt, sonst alle mit " +
      "Traffic/Verkauf; 'limit' begrenzt die Liste.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string", description: "Genau diesen ASIN zeigen (auch wenn nur ein Listing existiert)." },
        limit: { type: "number", description: "Höchstzahl Produkte (nach S&T-Umsatz sortiert)." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => {
      // Dieses Tool braucht ALLE drei Reports — anders als die übrigen.
      const [s, o, l] = await Promise.all([
        ctx.ladeReport(SALES_TYPE),
        ctx.ladeReport(ORDERS_TYPE),
        ctx.ladeReport(LISTINGS_TYPE),
      ]);
      if (!s && !o && !l) return keineDaten("Sales & Traffic / Orders / Listings");
      const q = (r: typeof s): Quelle | null =>
        r ? { payload: r.payload as Record<string, any>, data_timestamp: r.data_timestamp } : null;
      const asin = typeof args.asin === "string" ? args.asin.trim() : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return baueProductPerformance(q(s), q(o), q(l), { asin, limit });
    },
  },
  {
    name: "get_returns_overview",
    description:
      "Merchant-Retouren nach Antragsdatum: Anzahl, Einheiten, erstattete Beträge, " +
      "gruppiert nach Retourengrund, Resolution, Status und ASIN. HINWEIS: an echten " +
      "Retouren-Daten noch nicht validiert (Report war bei Erstellung leer) — die " +
      "Antwort trägt `unvalidiert: true`. Die Retourenquote (Retouren / verkaufte " +
      "Einheiten) ist NICHT enthalten: der Nenner kommt aus Sales/Orders.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => {
      const row = await ctx.ladeReport(RETURNS_TYPE);
      if (!row) return keineDaten(RETURNS_TYPE);
      return baueReturnsOverview(row.payload as Record<string, any>, row.data_timestamp);
    },
  },
  {
    name: "get_ads_overview",
    description:
      "Amazon-Advertising-Kennzahlen (Sponsored Products): Impressions, Klicks, " +
      "Spend, attribuierter Umsatz, ACOS und ROAS — je Kampagne und je ASIN. ACOS " +
      "(Spend/Umsatz) ist die zentrale Effizienzkennzahl. Aus Rohwerten gerechnet. " +
      "WICHTIG: ist der Zeitraum jünger als ~72h, ist der Datensatz vorläufig " +
      "(is_provisional) — Amazon passt Spend/Umsatz noch an. Getrennt von den " +
      "organischen Zahlen (get_sales_overview): Ads misst NUR die beworbene Leistung.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => {
      const row = await ctx.ladeReport("sp-advertised-product", "ads");
      if (!row) return keineDaten("sp-advertised-product (Ads)");
      const p = row.payload as Record<string, any>;
      return baueAdsOverview(p.rows ?? [], row.data_timestamp, row.is_provisional);
    },
  },
  {
    name: "get_ads_verlauf",
    description:
      "Sponsored-Products-Kennzahlen über einen FREI WÄHLBAREN Zeitraum (bis ~95 Tage " +
      "zurück, so weit die Tagesreihe reicht): Spend, attribuierter Umsatz, ACOS, ROAS, " +
      "CTR und CPC — als Gesamtwert, als Tageskurve (proTag) sowie je Kampagne und je " +
      "ASIN. Zeitraum via von/bis ('YYYY-MM-DD'), Default letzte 30 Tage. " +
      "UNTERSCHIED zu get_ads_overview: jenes zeigt immer nur das zuletzt gezogene " +
      "Report-Fenster; hier bestimmst du den Zeitraum und bekommst den Verlauf. " +
      "Für Trends, Vorher/Nachher-Vergleiche und Monatsbetrachtungen dieses Werkzeug " +
      "nehmen. Endet der Zeitraum in den letzten ~72h, ist er vorläufig (is_provisional). " +
      "Reichen die Daten nicht über den ganzen Zeitraum, steht das in `warnungen` — " +
      "fehlende Tage sind NICHT als 0 enthalten.",
    inputSchema: ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_verlauf", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_struktur",
    description:
      "Aufbau des Werbekontos (Sponsored Products) aus dem letzten Struktur-Snapshot: " +
      "Kampagnen mit Tagesbudget, Gebotsstrategie und Platzierungs-Modifiern (Top of " +
      "Search / Produktseite / Rest in %), Anzeigengruppen mit Standardgebot, und je " +
      "Kampagne die Zahl der Keywords, Targets und Negatives. Mit campaign_id kommen " +
      "zusätzlich alle Keywords/Targets dieser Kampagne mit Gebot (effektiv; `geerbt` " +
      "= erbt das Standardgebot der Gruppe), Match-Type und Zustand sowie alle Negatives. " +
      "Ersetzt die Bulk-Datei aus der Konsole. `stand` sagt, wann der Snapshot gezogen wurde.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string", description: "Kampagnen-ID — dann mit allen Zielen und Negatives dieser Kampagne." },
        nur_aktive: { type: "boolean", description: "Default true: archivierte Kampagnen ausblenden." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_struktur", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_suchbegriffe",
    description:
      "Suchbegriff-Bericht (Sponsored Products) über einen FREI WÄHLBAREN Zeitraum: welche " +
      "Suchanfragen der Kunden über welches Keyword/Target (Sponsored Products und Brands) Impressions, Klicks, Spend, " +
      "Bestellungen und Umsatz brachten — mit ACOS, CTR, CVR und CPC je Suchbegriff. Nach " +
      "Spend sortiert, Default 500 Einträge (limit bis 5000), optional auf eine campaign_id " +
      "eingeschränkt. Grundlage für Negatives (Klicks ohne Bestellung) und Keyword-Ernte " +
      "(Bestellungen ohne eigenes Exact-Keyword). Zeitraum via von/bis, Default letzte 30 Tage.",
    inputSchema: {
      type: "object",
      properties: {
        von: { type: "string", description: "Startdatum 'YYYY-MM-DD' (inklusiv). Default: vor 30 Tagen." },
        bis: { type: "string", description: "Enddatum 'YYYY-MM-DD' (inklusiv). Default: heute." },
        campaign_id: { type: "string", description: "Nur Suchbegriffe dieser Kampagne." },
        limit: { type: "number", description: "Max. Einträge (nach Spend), Default 500, höchstens 5000." },
        ad_product: { type: "string", enum: ["SP", "SB", "SD"], description: "Nur ein Anzeigentyp: SP (Sponsored Products, 7-Tage-Attribution), SB (Brands, 14 Tage) oder SD (Display, 14 Tage). Ohne Angabe alle." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_suchbegriffe", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_platzierungen",
    description:
      "Platzierungsbericht (Sponsored Products) über einen FREI WÄHLBAREN Zeitraum: Leistung " +
      "je Platzierung — Top of Search, Produktseite, Rest der Suche — gesamt und je Kampagne, " +
      "mit Spend, Umsatz, ACOS, CTR und CVR. Die aktuell gesetzten Platzierungs-Modifier " +
      "stehen in get_ads_struktur; zusammen sagen beide, ob ein Modifier hoch oder runter " +
      "sollte. Zeitraum via von/bis, Default letzte 30 Tage. Sponsored Products und Brands; " +
      "ad_product schränkt auf einen Typ ein.",
    inputSchema: {
      type: "object",
      properties: {
        von: { type: "string", description: "Startdatum 'YYYY-MM-DD' (inklusiv). Default: vor 30 Tagen." },
        bis: { type: "string", description: "Enddatum 'YYYY-MM-DD' (inklusiv). Default: heute." },
        ad_product: { type: "string", enum: ["SP", "SB", "SD"], description: "Nur ein Anzeigentyp: SP (Sponsored Products, 7-Tage-Attribution), SB (Brands, 14 Tage) oder SD (Display, 14 Tage). Ohne Angabe alle." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_platzierungen", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_ziele",
    description:
      "Ziel-Ebene mit Leistung über einen FREI WÄHLBAREN Zeitraum: jedes Keyword und jedes " +
      "Product-Target (Sponsored Products, Brands und Display) mit Impressions, Klicks, Spend, " +
      "Bestellungen, Umsatz, ACOS, CTR, CVR, CPC — dazu Gebot und Zustand vom jüngsten Tag im " +
      "Zeitraum. Das ist die Ebene, auf der Gebote entschieden werden (Bulk-Datei: Blätter " +
      "Keyword und Produkt-Targeting). Nach Spend sortiert, Default 500 Einträge (limit bis " +
      "5000), optional auf campaign_id und/oder ad_product eingeschränkt. Zeitraum via von/bis, " +
      "Default letzte 30 Tage. UNTERSCHIED zu get_ads_struktur: dort steht der aktuelle Aufbau " +
      "ohne Leistung; hier die Leistung je Ziel im Zeitraum.",
    inputSchema: {
      type: "object",
      properties: {
        von: { type: "string", description: "Startdatum 'YYYY-MM-DD' (inklusiv). Default: vor 30 Tagen." },
        bis: { type: "string", description: "Enddatum 'YYYY-MM-DD' (inklusiv). Default: heute." },
        campaign_id: { type: "string", description: "Nur Ziele dieser Kampagne." },
        limit: { type: "number", description: "Max. Einträge (nach Spend), Default 500, höchstens 5000." },
        ad_product: { type: "string", enum: ["SP", "SB", "SD"], description: "Nur ein Anzeigentyp: SP (Sponsored Products, 7-Tage-Attribution), SB (Brands, 14 Tage) oder SD (Display, 14 Tage). Ohne Angabe alle." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_ziele", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_sales_history",
    description:
      "Sales-&-Traffic-Kennzahlen über einen FREI WÄHLBAREN Zeitraum aus der " +
      "historischen Tagesreihe (bis ~24 Monate zurück). Liefert Gesamt-Kennzahlen " +
      "(Umsatz, Sessions, CVR, Durchschnittspreis — aus Rohwerten) UND eine " +
      "Monatsreihe für Vergleiche/Trends. Für Jahresvergleiche, 'letzte 12 Monate', " +
      "Vormonat vs. Vorjahr usw. Zeitraum via von/bis ('YYYY-MM-DD').",
    inputSchema: ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => {
      if (!ctx.ladeVerlauf) return verlaufNichtVerfuegbar();
      return ctx.ladeVerlauf("sales", args);
    },
  },
  {
    name: "get_orders_history",
    description:
      "Bestell-Kennzahlen über einen FREI WÄHLBAREN Zeitraum aus der Historie (bis " +
      "~24 Monate). Bestellungen, Einheiten, Umsatz je Kanal/Status/ASIN. Gleiche " +
      "ehrliche Logik wie get_orders_overview (leere Preise = unbekannt, mehrere " +
      "Kanäle getrennt). Zeitraum via von/bis ('YYYY-MM-DD').",
    inputSchema: ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => {
      if (!ctx.ladeVerlauf) return verlaufNichtVerfuegbar();
      return ctx.ladeVerlauf("orders", args);
    },
  },
  {
    name: "get_orders_revenue",
    description:
      "TAGESAKTUELLER Umsatz aus den BESTELLUNGEN (orders_history) über einen frei " +
      "wählbaren Zeitraum — näher an Sellerboard und aktueller als get_sales_history " +
      "(Sales & Traffic hat 1–2 Tage Amazon-Verzug). Tag-Grenze Europe/Berlin, Stornos " +
      "ausgeschlossen, Pending inkl. Liefert Gesamt-Umsatz/Einheiten, Monatsreihe und " +
      "Preisabdeckung; fehlende Preise => Umsatz ist eine Untergrenze. Zeitraum via " +
      "von/bis ('YYYY-MM-DD').",
    inputSchema: ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => {
      if (!ctx.ladeVerlauf) return verlaufNichtVerfuegbar();
      return ctx.ladeVerlauf("orders_umsatz", args);
    },
  },
  {
    name: "get_returns_history",
    description:
      "Retouren über einen FREI WÄHLBAREN Zeitraum aus der Historie (bis ~24 Monate): " +
      "Anzahl, Einheiten, erstattete Beträge, nach Grund/Resolution/Status/ASIN. " +
      "Zeitraum via von/bis ('YYYY-MM-DD').",
    inputSchema: ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => {
      if (!ctx.ladeVerlauf) return verlaufNichtVerfuegbar();
      return ctx.ladeVerlauf("returns", args);
    },
  },
  // --- Pulse-Analytics (READ-ONLY; alles, was wir über die 6 Overviews hinaus gebaut haben) ---
  {
    name: "get_products",
    description:
      "Per-Produkt-Übersicht je ASIN über einen FREI WÄHLBAREN Zeitraum (bis ~24 Monate): " +
      "Umsatz, Einheiten, Retouren und — falls Einkaufspreise (EK) hinterlegt sind — " +
      "Rohertrag/Rohmarge. Ideal zum Suchen/Filtern nach Produktname oder ASIN über die " +
      "Historie. Zeitraum via von/bis ('YYYY-MM-DD'), Default letzte 90 Tage.",
    inputSchema: ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("produkte", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_kpi_history",
    description:
      "Monatliche KPI-Zeitreihe des Kontos (bis ~24 Monate): Umsatz, Einheiten, Sessions, " +
      "Conversion-Rate, Retourenquote sowie — sofern verbunden — Amazon-Gebühren und " +
      "Nettogewinn/Nettomarge. Für Trends und Monatsvergleiche.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => (ctx.ladePulse ? ctx.ladePulse("kpi", {}) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_profit_history",
    description:
      "Monatlicher Ertrag: Umsatz, Wareneinsatz (EK), Rohertrag/Rohmarge und — sofern " +
      "Gebühren verbunden — Nettogewinn/Nettomarge. Rohertrag nur, wo EK je ASIN hinterlegt " +
      "ist; sonst null (nicht 0). Ads noch nicht enthalten.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ertrag", {}) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_search_query_performance",
    description:
      "Search-Query-Performance (Brand Analytics) je ASIN: eigene vs. Markt-CTR/CVR und " +
      "Kaufanteil pro Suchbegriff. Mit 'asin' → die Suchbegriffe dieser ASIN; ohne 'asin' → " +
      "Liste der ASINs, für die Daten vorliegen. READ-ONLY: liefert nur bereits abgerufene " +
      "Zeiträume ('vorhanden' in der Antwort), stößt selbst keinen Report bei Amazon an.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string", description: "ASIN, deren Suchbegriffe geliefert werden. Weglassen für die Liste verfügbarer ASINs." },
        periode: { type: "string", enum: ["WEEK", "MONTH"], description: "Wochen- oder Monatssicht. Standard: WEEK." },
        von: { type: "string", description: "Erster Tag des Zeitraums (YYYY-MM-DD). Weglassen für den zuletzt abgerufenen Zeitraum." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("sqp", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_diagnoses",
    description:
      "Pulse-Diagnosen (regelbasiert, KEINE Kausalitätsbehauptung): Beobachtung, Begründung, " +
      "Datenbasis, Konfidenz, Priorität, Status. Beobachtung ≠ Begründung.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => (ctx.ladePulse ? ctx.ladePulse("diagnosen", {}) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_change_log",
    description:
      "Änderungs-Log je ASIN (automatisch erkannt: Preis, Bestand/Out-of-Stock, Listing-Status, " +
      "Fulfillment; plus manuell erfasste wie Bilder/Bewertungen). Filter via asin, von/bis " +
      "('YYYY-MM-DD'). Fakt getrennt von Interpretation.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string" },
        von: { type: "string", description: "'YYYY-MM-DD'" },
        bis: { type: "string", description: "'YYYY-MM-DD'" },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("aenderungen", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_strategy_overview",
    description:
      "Strategie-Layer je ASIN: aktive Rolle (launch/scale/hold/harvest/exit), Korridor-Status " +
      "und die max. 3 wichtigsten Findings der Woche plus offene Rollen-Vorschläge. Nur für " +
      "Produkte mit Umsatz oder fester Rolle.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => (ctx.ladePulse ? ctx.ladePulse("strategie", {}) : pulseNichtVerfuegbar()),
  },
];

function verlaufNichtVerfuegbar(): Record<string, unknown> {
  return { fehler: "Verlaufs-Abfrage in diesem Kontext nicht verfügbar." };
}

function pulseNichtVerfuegbar(): Record<string, unknown> {
  return { fehler: "Diese Auswertung ist über diese Schnittstelle nicht verfügbar." };
}

function keineDaten(reportType: string): Record<string, unknown> {
  return {
    keine_daten: true,
    hinweis: `Für ${reportType} liegen noch keine Daten vor. Der tägliche Sync füllt sie; ` +
      "einmalig kann sync-report aufgerufen werden.",
  };
}

// --- JSON-RPC ---

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ergebnis(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fehler(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function toolListe(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export function toolNamen(): string[] {
  return TOOLS.map((t) => t.name);
}

/**
 * Ruft einen Tool-Handler direkt auf und gibt das ROHE Ergebnis zurück (ohne
 * MCP-content-Hülle). Damit kann der Web-Endpunkt `api` dieselbe getestete Logik
 * nutzen wie der MCP-Server, statt sie zu duplizieren.
 */
export function rufeToolAuf(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unbekannte Ressource: ${name}`);
  return tool.handle(args, ctx);
}

function waehleProtokoll(angefragt: unknown): string {
  return typeof angefragt === "string" && UNTERSTUETZTE_VERSIONEN.includes(angefragt)
    ? angefragt
    : UNTERSTUETZTE_VERSIONEN[0];
}

/**
 * Verarbeitet EINE JSON-RPC-Nachricht.
 * Rückgabe null = Notification (keine Antwort schicken, z.B. notifications/*).
 */
export async function dispatch(
  req: JsonRpcRequest,
  ctx: McpContext
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const method = req.method;

  // Notifications haben keine id und erwarten keine Antwort.
  if (method && method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return ergebnis(id, {
        protocolVersion: waehleProtokoll(req.params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return ergebnis(id, {});

    case "tools/list":
      return ergebnis(id, { tools: toolListe() });

    case "tools/call": {
      const name = req.params?.name as string | undefined;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return fehler(id, -32602, `Unbekanntes Tool: ${name}`);
      }
      try {
        const daten = await tool.handle(args, ctx);
        // MCP-Ergebnis: die Daten als JSON-Text im content.
        //
        // BEWUSST OHNE structuredContent: das darf laut Spec nur mitkommen, wenn
        // das Tool ein outputSchema deklariert — unsere Tools tun das nicht (die
        // Ausgaben sind je Report zu heterogen für ein sinnvolles Schema).
        // Strenge Clients lehnen ein Ergebnis mit unangekündigtem
        // structuredContent ab; tolerante ignorieren es. Genau daran scheiterte
        // tools/call bei Claude, waehrend ChatGPT dieselben Antworten annahm.
        // Die Daten gehen durch den Text-Content nicht verloren.
        //
        // isError bleibt false — ein "keine Daten"-Zustand ist kein Protokollfehler.
        return ergebnis(id, {
          content: [{ type: "text", text: JSON.stringify(daten, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // Tool-Ausführungsfehler werden laut MCP als result mit isError:true
        // gemeldet, NICHT als JSON-RPC-Fehler — so sieht das Modell die Ursache.
        return ergebnis(id, {
          content: [{ type: "text", text: `Fehler im Tool ${name}: ${String(e)}` }],
          isError: true,
        });
      }
    }

    default:
      return fehler(id, -32601, `Methode nicht unterstützt: ${method ?? "(keine)"}`);
  }
}

/** Baut eine JSON-RPC-Fehlerantwort für kaputte Eingaben (Parse/Struktur). */
export function protokollFehler(id: string | number | null, message: string): JsonRpcResponse {
  return fehler(id, -32700, message);
}

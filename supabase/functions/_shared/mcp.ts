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
import { baueAccountHealth } from "./account_health.ts";

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

import { zugriffErlaubt } from "./entitlements.ts";

export interface McpContext {
  /**
   * Tarif-Flags des Mandanten. null = nicht geprueft (Coach-Zugang oder Unit-
   * Test) -> alle Werkzeuge erlaubt. Ein LEERES Objekt sperrt dagegen alles,
   * genau wie im Web: fehlt der Eintrag, ist das Feature nicht im Tarif.
   */
  features?: Record<string, boolean> | null;
  /** Coach-/Admin-Zugang umgeht das Gating vollstaendig. */
  coach?: boolean;
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

// Wie ZEITRAUM_SCHEMA, aber mit Marktplatz. Nur fuer Ads-Leser: die anderen
// Werkzeuge auf ZEITRAUM_SCHEMA kennen keine Werbe-Profile.
const ADS_ZEITRAUM_SCHEMA = {
  type: "object",
  properties: {
    ...ZEITRAUM_SCHEMA.properties,
    marktplatz: {
      type: "string",
      description:
        "Marktplatz-ID, z. B. A13V1IB3VIYZZH fuer Frankreich. Ohne Angabe der Marktplatz der " +
        "SP-Verbindung. Ein Werbe-Profil gilt je Marktplatz — Zahlen verschiedener Laender " +
        "werden nie gemischt. Welche freigeschaltet sind, steht in jeder Antwort unter " +
        "verfuegbare_marktplaetze.",
    },
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
    inputSchema: ADS_ZEITRAUM_SCHEMA,
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
        marktplatz: { type: "string", description: "Marktplatz-ID, z. B. A13V1IB3VIYZZH fuer Frankreich. Ohne Angabe der Marktplatz der SP-Verbindung. Ein Werbe-Profil gilt je Marktplatz — Zahlen verschiedener Laender werden nie gemischt. Welche freigeschaltet sind, steht in jeder Antwort unter verfuegbare_marktplaetze." },
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
        marktplatz: { type: "string", description: "Marktplatz-ID, z. B. A13V1IB3VIYZZH fuer Frankreich. Ohne Angabe der Marktplatz der SP-Verbindung. Ein Werbe-Profil gilt je Marktplatz — Zahlen verschiedener Laender werden nie gemischt. Welche freigeschaltet sind, steht in jeder Antwort unter verfuegbare_marktplaetze." },
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
      "sollte. Zeitraum via von/bis, Default letzte 30 Tage. NUR Sponsored Products: für " +
      "Sponsored Brands gibt Amazon keinen Platzierungsbericht her.",
    inputSchema: {
      type: "object",
      properties: {
        von: { type: "string", description: "Startdatum 'YYYY-MM-DD' (inklusiv). Default: vor 30 Tagen." },
        bis: { type: "string", description: "Enddatum 'YYYY-MM-DD' (inklusiv). Default: heute." },
        ad_product: { type: "string", enum: ["SP", "SB", "SD"], description: "Nur ein Anzeigentyp: SP (Sponsored Products, 7-Tage-Attribution), SB (Brands, 14 Tage) oder SD (Display, 14 Tage). Ohne Angabe alle." },
        marktplatz: { type: "string", description: "Marktplatz-ID, z. B. A13V1IB3VIYZZH fuer Frankreich. Ohne Angabe der Marktplatz der SP-Verbindung. Ein Werbe-Profil gilt je Marktplatz — Zahlen verschiedener Laender werden nie gemischt. Welche freigeschaltet sind, steht in jeder Antwort unter verfuegbare_marktplaetze." },
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
        marktplatz: { type: "string", description: "Marktplatz-ID, z. B. A13V1IB3VIYZZH fuer Frankreich. Ohne Angabe der Marktplatz der SP-Verbindung. Ein Werbe-Profil gilt je Marktplatz — Zahlen verschiedener Laender werden nie gemischt. Welche freigeschaltet sind, steht in jeder Antwort unter verfuegbare_marktplaetze." },
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
    name: "get_inventory_overview",
    description:
      "Gesamtbestand je ASIN über ALLE Quellen: Amazon SP-API (FBA verfügbar, " +
      "FBA reserviert, Inbound zu Amazon) plus externe Bestände aus Sellerboard " +
      "(eigenes Lager, Prep Center, 3PL/Logistiker, bestellt beim Lieferanten, " +
      "AWD, sonstige Pipeline). Zwei Summen, die NICHT vermischt werden dürfen: " +
      "`physisch_gesamt` = FBA + externes Lager (greifbar, kann angeliefert " +
      "werden) und `pipeline_gesamt` = Inbound + bestellt + AWD/unterwegs (kommt " +
      "noch); `versorgung_gesamt` ist beides zusammen. Amazon ist für FBA und " +
      "Inbound die primäre Quelle — Sellerboard-FBA-Werte werden NICHT gezählt, " +
      "wenn Amazon liefert (Feld `doppelt_uebersprungen`). Dazu `kapital`: " +
      "Kapitalbindung zum Einkaufspreis je Klasse (FBA, extern, bestellt, " +
      "Inbound), Wert ausserhalb Amazons, EK-Abdeckung und Reichweite in Tagen " +
      "(FBA / physisch / Versorgung) aus der Verkaufsgeschwindigkeit der letzten " +
      "90 Tage. WICHTIG: null heisst unbekannt, nicht 0 — besonders bei FBA ohne " +
      "Amazon-Datensatz und bei Werten ohne EK. `hinweise` immer mit ausgeben.",
    inputSchema: LEERES_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("bestand", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_cashflow",
    description:
      "Geldfluss INNERHALB von Amazon — nicht Gewinn. Beantwortet: wann kommt die " +
      "nächste Auszahlung und wo liegt der Abrechnungsschnitt (auf die Minute, aus " +
      "dem Settlement-Bericht gemessen), wie hoch ist der Einbehalt, wie viel Geld " +
      "steckt in noch nicht abgerechneten Bestellungen, an welchem Tag im Monat " +
      "bucht Amazon Lagergebühr und Kontogebühr ab, nach welchem Muster werden " +
      "Werbekosten abgezogen (Termin oder Rechnungsschwelle), wie viel " +
      "Vorsteuer steckt in den Gebühren, und wie hoch ist die " +
      "Umsatzsteuer-Zahllast je Monat samt Fälligkeit — je Marktplatz getrennt, " +
      "weil jedes Land seine eigene Meldung hat. Dazu ein KALENDER der " +
      "nächsten 60 Tage im Feld `kalender`: welche Zahlung wann erwartet wird, " +
      "mit Wochensummen. Jede Position trägt `sicher` und `grundlage` — die " +
      "TERMINE sind gemessen, die BETRÄGE fortgeschrieben und nie zugesagt. " +
      "Das gehört in jede Antwort, die eine dieser Zahlen nennt. " +
      "Zur Zahllast IMMER dazusagen, dass sie nur Amazon-Daten enthält: " +
      "Vorsteuer aus Wareneinkauf und Betriebsausgaben fehlt, die echte " +
      "Zahllast liegt niedriger. Sie ist keine Grundlage für die Voranmeldung. " +
      "Auslandsumsätze stehen getrennt (OSS), die Trennung folgt dem Marktplatz " +
      "und nicht dem Bestimmungsland. " +
      "Alle Rhythmen sind AM KONTO GEMESSEN, nicht aus Amazons Faustregeln " +
      "übernommen — sie unterscheiden sich je Konto. " +
      "WICHTIG: `warnungen` immer mit ausgeben. Felder mit null sind UNBEKANNT, " +
      "nicht null Euro; das gilt besonders für Einbehalt und gebundenes Geld. " +
      "Optional `tage` (30–365, Vorgabe 120) für das Messfenster.",
    inputSchema: {
      type: "object",
      properties: {
        tage: { type: "integer", description: "Messfenster in Tagen (30–365, Vorgabe 120)" },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("cashflow", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_products",
    description:
      "Per-Produkt-Übersicht je ASIN über einen FREI WÄHLBAREN Zeitraum (bis ~24 Monate): " +
      "Umsatz, Einheiten, Retouren und — falls Einkaufspreise (EK) hinterlegt sind — " +
      "Rohertrag/Rohmarge. Ideal zum Suchen/Filtern nach Produktname oder ASIN über die " +
      "Historie. Zeitraum via von/bis ('YYYY-MM-DD'), Default letzte 90 Tage. " +
      "WICHTIG: Das Feld `warnungen` (Liste von Sätzen) IMMER mit ausgeben, wenn es " +
      "gefüllt ist — es nennt fehlende Datenstände, etwa Monate ohne Lagergebühren. " +
      "Fehlende Lagergebühren erscheinen als 0,00 €, sind aber UNBEKANNT; Marge und " +
      "Gewinn fallen dann zu günstig aus.",
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
      "Search-Query-Performance (Brand Analytics) je ASIN UND Marktplatz: eigene vs. " +
      "Markt-CTR/CVR und Kaufanteil pro Suchbegriff. Mit 'asin' → die Suchbegriffe dieser " +
      "ASIN; ohne 'asin' → Liste der ASINs, für die Daten vorliegen. " +
      "Suchbegriffe und Kaufanteile sind je LAND verschieden — 'marktplatz' waehlt es aus " +
      "(z. B. 'fr'); ohne Angabe gilt der Marktplatz der Amazon-Verbindung, meist Deutschland. " +
      "Welche Laender und Zeitraeume schon abgerufen sind, steht in 'vorhanden' der Antwort. " +
      "READ-ONLY: liefert nur bereits abgerufene Zeitraeume, stoesst selbst keinen Report " +
      "bei Amazon an.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string", description: "ASIN, deren Suchbegriffe geliefert werden. Weglassen für die Liste verfügbarer ASINs." },
        periode: { type: "string", enum: ["WEEK", "MONTH"], description: "Wochen- oder Monatssicht. Standard: WEEK." },
        von: { type: "string", description: "Erster Tag des Zeitraums (YYYY-MM-DD). Weglassen für den zuletzt abgerufenen Zeitraum." },
        marktplatz: {
          type: "string",
          description:
            "Marktplatz: Kuerzel wie 'de', 'fr', 'it', 'es', 'nl', 'be', 'pl', 'se', 'co.uk' " +
            "oder die Amazon-Marketplace-ID. Weglassen fuer den Marktplatz der Verbindung. " +
            "Eine unbekannte Angabe wird abgelehnt und NICHT still durch Deutschland ersetzt.",
        },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("sqp", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_changelog",
    description:
      "Gebots- und Statusaenderungen je Ziel (Keyword/Target), mit den Kennzahlen der " +
      "7 Tage davor und danach. Beantwortet: lag der ACoS-Sprung an einer Aenderung oder " +
      "an Amazon? Je vergleichbarer Aenderung zusaetzlich `urteil` (Umsatz und ROAS danach " +
      "gegen davor: beides_besser / umsatz_besser_roas_schlechter / " +
      "roas_besser_umsatz_schlechter / beides_schlechter), `umsatz_differenz` und `treiber` " +
      "(Zerlegung der Umsatzdifferenz in Kosten, CPC, CVR, Warenkorb). `bilanz` zaehlt die " +
      "Urteile je Richtung (hoch/runter) und summiert Zuwachs und Rueckgang. " +
      "WICHTIG zur Einordnung: die Liste ist aus den TAGESSTAENDEN abgeleitet, nicht aus " +
      "Amazons Protokoll — sie sieht deshalb auch Aenderungen, die jemand direkt in der " +
      "Amazon-Konsole gemacht hat, aber KEINE, die am selben Tag zurueckgenommen wurde. " +
      "Ein Ziel bekommt nur an Tagen eine Zeile, an denen Amazon etwas meldet; wo Tage " +
      "fehlen, ist der Aenderungstag nur auf ein Fenster genau ('luecke_tage', " +
      "'datierung'). " +
      "Der Vergleich davor/danach ist ein NEBENEINANDER, kein Beweis: in denselben sieben " +
      "Tagen aendern sich Wettbewerb, Saison und Auktion mit. Nur Ereignisse mit " +
      "'vergleichbar': true haben genug Traffic und vollen Nachlauf; sonst steht in " +
      "'grund', warum nicht. Nur die verbundenen Ads-Marktplaetze (heute Deutschland).",
    inputSchema: {
      type: "object",
      properties: {
        von: { type: "string", description: "Erster Tag (YYYY-MM-DD). Ohne Angabe die letzten 90 Tage." },
        bis: { type: "string", description: "Letzter Tag (YYYY-MM-DD)." },
        campaign_id: { type: "string", description: "Nur diese Kampagne." },
        marktplatz: { type: "string", description: "Marktplatz-ID, z. B. A13V1IB3VIYZZH fuer Frankreich. Ohne Angabe der Marktplatz der SP-Verbindung. Ein Werbe-Profil gilt je Marktplatz — Zahlen verschiedener Laender werden nie gemischt. Welche freigeschaltet sind, steht in jeder Antwort unter verfuegbare_marktplaetze." },
        nur_auswertbar: {
          type: "boolean",
          description:
            "true = nur Aenderungen mit mindestens 5 Klicks VOR und NACH der Aenderung. " +
            "Bei Vaneja sind das 74 von 783 — der Rest sind Ziele ohne Traffic, bei denen " +
            "ein Vorher/Nachher Zufall waere.",
        },
        limit: { type: "number", description: "Hoechstzahl Ereignisse (Standard 200, max 2000)." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_changelog", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_struktur_aenderungen",
    description:
      "Was am AUFBAU des Werbekontos geaendert wurde: Tagesbudget, Zustand, Gebotsstrategie " +
      "und Platzierungs-Modifier je Kampagne, Standardgebot je Anzeigengruppe, Gebot und " +
      "Zustand je Keyword/Target/Negative — jeweils mit Wert vorher und nachher. Dazu " +
      "`neu_angelegt`: Keywords, Targets und Negatives, die im Zeitraum zum ersten Mal " +
      "auftauchten (Keyword-Ernte, neue Negatives). " +
      "EINORDNUNG: abgeleitet aus dem taeglichen Struktur-Snapshot, nicht aus Amazons " +
      "Protokoll. Eine Aenderung ist nur auf das Fenster zwischen zwei Snapshots genau " +
      "(`fenster_ab` bis `erkannt_am`); wer geaendert hat, steht hier nicht. Die Spur " +
      "beginnt erst mit ihrer Einrichtung (04.10.2026) — davor gibt es nichts. " +
      "UNTERSCHIED zu get_ads_changelog: jenes zeigt Gebotsaenderungen MIT Kennzahlen " +
      "davor/danach aus den Tagesreihen; dieses zeigt auch Budget, Modifier und Negatives, " +
      "aber ohne Kennzahlen. Zeitraum via von/bis, Default letzte 30 Tage.",
    inputSchema: {
      type: "object",
      properties: {
        ...ADS_ZEITRAUM_SCHEMA.properties,
        campaign_id: { type: "string", description: "Nur diese Kampagne." },
        limit: { type: "number", description: "Hoechstzahl je Liste (Standard 500, max 2000)." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_struktur_aenderungen", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_kandidaten",
    description:
      "Handlungskandidaten aus den Suchbegriffen (Sponsored Products): " +
      "`negativ_kandidaten` = Suchbegriffe mit Klicks und Kosten, aber ohne Bestellung, die in " +
      "ihrer Anzeigengruppe noch NICHT ausgeschlossen sind — mit Kosten, `zufall_prozent` (wie oft " +
      "null Bestellungen bei dieser Klickzahl reiner Zufall waeren, gemessen an der Konto-CVR) und " +
      "`bestellungen_anderswo` (verkauft der Begriff in einer anderen Gruppe?). `aktion` " +
      "unterscheidet `negativ_anlegen` von `ziel_pruefen` (der Begriff ist selbst das Exact-Keyword " +
      "oder ASIN-Target der Gruppe — dann hilft kein Negative). " +
      "`ernte_kandidaten` = Suchbegriffe mit Bestellungen, fuer die es im Konto kein aktives " +
      "Exact-Keyword gibt, je Begriff ueber alle Gruppen summiert und SORTIERT NACH " +
      "`gewinn_nach_werbung` (Umsatz x Break-even minus Werbekosten). `einordnung`: traegt_sich / " +
      "ueber_break_even / marge_unbekannt. `break_even_acos` steht auf BRUTTO-Umsatz und ist " +
      "deshalb mit dem ACoS vergleichbar. `zielgebot` = Umsatz je Bestellung x Ziel-ACoS x " +
      "geschaetzte CVR; bei `zielgebot_basis: break_even` ist es die Obergrenze, kein Vorschlag. " +
      "Mit `asin`: zusaetzlich alle Suchbegriffe der Anzeigengruppen, die diese ASIN bewerben " +
      "(`eindeutig` = die Gruppe bewirbt nur diese ASIN). " +
      "Zeitraum via von/bis, Default letzte 60 Tage. Schwellen: min_klicks (Default 10), " +
      "min_bestellungen (Default 2). Vorhandene Negatives und Keywords stammen aus dem letzten " +
      "Struktur-Snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        ...ADS_ZEITRAUM_SCHEMA.properties,
        min_klicks: { type: "number", description: "Negativ-Kandidaten ab so vielen Klicks ohne Bestellung. Default 10." },
        min_bestellungen: { type: "number", description: "Ernte-Kandidaten ab so vielen Bestellungen. Default 2." },
        asin: { type: "string", description: "Zusaetzlich die Suchbegriffe zu dieser beworbenen ASIN." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_kandidaten", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_keyword_wirkung",
    description:
      "Was haben NEU ANGELEGTE Keywords und Targets gebracht (Sponsored Products). Je Ziel: " +
      "`eigen` = Klicks, Kosten, Umsatz, Bestellungen, ACoS seit dem Anlegen; `vorher` = derselbe " +
      "Suchbegriff ueber ANDERE Ziele im gleich langen Fenster davor; `anderswo` = derselbe " +
      "Suchbegriff ueber andere Ziele seither; `gesamt_danach` = eigen + anderswo. Die Differenzen " +
      "(umsatz_differenz, kosten_differenz, bestellungen_differenz) vergleichen gesamt_danach mit " +
      "vorher — so zeigt sich, ob ein Exact-Keyword etwas gewonnen oder nur aus einer anderen " +
      "Kampagne herueberverlagert hat. `status`: auswertbar / wenig_traffic / kein_traffic / " +
      "zu_frueh, mit `grund`. `begriff_eingebrochen: true` = der Suchbegriff hatte davor Traffic und " +
      "ist seit dem Anlegen ueber alle Ziele zusammen auf unter ein Viertel gefallen (beim Umzug " +
      "ins Exact verloren gegangen). `gebot_unter_klickpreis: true` = das Gebot liegt unter dem, " +
      "was der Klick davor ueber andere Ziele kostete — die naheliegendste Ursache. " +
      "Vorher-Vergleich nur bei Exact-Keywords und ASIN-Targets. " +
      "Anlagedatum aus dem Pulse-Protokoll (sekundengenau) oder dem Struktur-Snapshot (taggenau, " +
      "erst seit 04.10.2026). Bewusst ohne Urteil: es zaehlen der eigene ACoS und die Differenzen. " +
      "Nebeneinander, kein Beweis. Zeitraum (Anlagedatum) via von/bis, Default letzte 90 Tage.",
    inputSchema: ADS_ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_keyword_wirkung", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_kampagnen_wirkung",
    description:
      "Was kam nach einer BUDGET- oder PLATZIERUNGS-Aenderung an einer Kampagne (Sponsored Products). " +
      "Je Aenderung: Wert vorher/nachher, Quelle (`pulse_log` = ueber Pulse, minutengenau, mit " +
      "Begruendung; `snapshot` = im Struktur-Snapshot erkannt, auch Aenderungen in der Amazon-Konsole, " +
      "erst seit 04.10.2026), und die Kennzahlen der sieben Tage davor und danach — fuer die ganze " +
      "Kampagne (`kampagne_davor/danach`) und bei Platzierungen zusaetzlich fuer die geaenderte " +
      "Platzierung (`platzierung_davor/danach`). `urteil` steht bei Budget auf der Kampagne, bei " +
      "Platzierungen auf der Platzierung (`urteil_ebene`); `kampagne_umsatz_differenz` und " +
      "`kampagne_kosten_differenz` zeigen daneben immer die ganze Kampagne. Nur bei " +
      "`vergleichbar: true` gibt es ein Urteil, sonst steht in `grund`, warum nicht. " +
      "Nebeneinander, kein Beweis. UNTERSCHIED zu get_ads_changelog: jenes bewertet Gebote je " +
      "Keyword/Target; dieses Budget und Platzierungs-Aufschlag je Kampagne. " +
      "Zeitraum via von/bis, Default letzte 90 Tage.",
    inputSchema: ADS_ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_kampagnen_wirkung", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_negativ_wirkung",
    description:
      "Was hat ein angelegtes NEGATIVE abgeschnitten (Sponsored Products). Je Negative: `vorher` = der " +
      "Suchbegriff in seinem Geltungsbereich (Anzeigengruppe oder Kampagne) im gleich langen Fenster vor " +
      "der Anlage — das, was seither wegfaellt; `nachher` = derselbe danach (muesste null sein, sonst " +
      "`greift_nicht`); bei Exact-Negatives `anderswo_vorher/nachher` = derselbe Begriff in anderen " +
      "Gruppen. `einordnung`: kosten_gespart (davor Klicks ohne Bestellung) / bestellungen_verlagert " +
      "(anderswo kam mindestens so viel dazu) / bestellungen_abgeschnitten (anderswo kam weniger an als " +
      "wegfiel) / vorsorglich (davor kein Klick) / zu_frueh. `bestellungen_netto` = weggefallen plus " +
      "anderswo dazugekommen. Quellen: Pulse-Protokoll mit Begruendung, und Struktur-Snapshot seit " +
      "04.10.2026. Nebeneinander, kein Beweis. Zeitraum (Anlagedatum) via von/bis, Default 90 Tage.",
    inputSchema: ADS_ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_negativ_wirkung", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_kampagnen_starts",
    description:
      "Neu gestartete Sponsored-Products-Kampagnen und was sie seit dem Start gebracht haben: Klicks, " +
      "Kosten, Umsatz, Bestellungen, ACoS — gegen den Break-even der beworbenen ASINs gehalten " +
      "(`break_even_acos` auf Brutto-Umsatz, bei mehreren ASINs die schwaechste Marge) mit " +
      "`gewinn_nach_werbung`. `status`: auswertbar / wenig_traffic / kein_traffic / zu_frueh. " +
      "`einordnung`: traegt_sich / ueber_break_even / ohne_bestellung / marge_unbekannt. Sortiert nach " +
      "Deckungsbeitrag. Eine Ranking-Kampagne darf ueber dem Break-even liegen. Zeitraum (Startdatum) " +
      "via von/bis, Default letzte 90 Tage.",
    inputSchema: ADS_ZEITRAUM_SCHEMA,
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_kampagnen_starts", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_budget",
    description:
      "Budget-Auslastung der Sponsored-Products-Kampagnen: welche Kampagne an welchem Tag ihr " +
      "Tagesbudget ausgeschoepft hat, SEIT WANN (`ausgeschoepft_seit`, Amazons eigener Stempel der " +
      "letzten Bewegung, UTC) und wie viele Stunden sie danach bis Mitternacht deutscher Zeit ohne " +
      "Auslieferung blieb (`stunden_ohne_auslieferung`). `kampagnen` fasst je Kampagne zusammen: an " +
      "wie vielen Tagen leer und wie lange. Stuendlich gemessen, gespeichert ab 80 % Auslastung; " +
      "`messungen_je_tag` sagt, wie oft an einem Tag gemessen wurde. " +
      "EINORDNUNG: die Messung laeuft erst seit dem 04.10.2026. Entgangener Umsatz steht bewusst " +
      "nicht dabei — er waere aus Tageswerten nur zu raten. `steuerung` je Zeile (pulse/h10 = verwaltetes " +
      "Produkt, nur_analyse = nicht anfassen); `bilanz.gesteuert` zaehlt nur die verwalteten. " +
      "Ueber 100 % heisst: Budget gesenkt, " +
      "nachdem schon mehr ausgegeben war. Zeitraum via von/bis, Default letzte 14 Tage.",
    inputSchema: {
      type: "object",
      properties: {
        ...ADS_ZEITRAUM_SCHEMA.properties,
        nur_ausgeschoepft: { type: "boolean", description: "true = nur Kampagnentage mit 100 % (ohne die knappen ab 80 %)." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_budget", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_produkt_lage",
    description:
      "Lage je VERWALTETEM Produkt (nur Kampagnen, die in ads_steuerung als h10 oder pulse eingestuft sind): " +
      "Werbekosten, Werbeumsatz, Bestellungen, Klicks und ACoS der letzten `tage` Tage mit Ads-Daten gegen " +
      "die `tage` davor. Je Produkt `gesamt`, dazu getrennt `h10` (Kampagnen, deren Gebote die Helium-10-KI " +
      "setzt) und `pulse` (Kampagnen, die Pulse steuert), `h10_anteil_kosten` und " +
      "`kampagnentage_budget_leer`. Dazu `alle_bestellungen`: Umsatz des Produkts aus ALLEN Bestellungen im " +
      "selben Fenster mit `tacos` (Werbekosten / Gesamtumsatz) und `werbeanteil`; `break_even_tacos` (Marge vor " +
      "Werbung, 90 Tage) und `gewinn_nach_werbung` (Gesamtumsatz x Marge − Werbekosten) je Fenster. Der Einstieg fuer die Frage: wie laufen meine Produkte diese Woche. " +
      "EINORDNUNG: zwei Fenster nebeneinander, keine Ursache. h10 und pulse sind kein fairer Vergleich " +
      "(Helium 10 steuert meist die grossen Kampagnen). SP, SB und SD zusammen.",
    inputSchema: {
      type: "object",
      properties: {
        tage: { type: "integer", description: "Fensterlaenge in Tagen, 1 bis 60. Default 7." },
        marktplatz: ADS_ZEITRAUM_SCHEMA.properties.marktplatz,
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_produkt_lage", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_produkt_verlauf",
    description:
      "Tagesverlauf je VERWALTETEM Produkt: je Tag `werbekosten`, `werbeumsatz`, `gesamtumsatz` (alle " +
      "Bestellungen des Produkts), `einheiten` und `ohne_werbung` (Gesamt minus Werbung). `woche` summiert " +
      "den Tag und die sechs davor, mit `tacos`. Die Ergaenzung zu get_ads_produkt_lage: wenn dort der " +
      "Gesamtumsatz faellt, zeigt der Verlauf, AN WELCHEM TAG. " +
      "EINORDNUNG: `ohne_werbung` ist gerechnet, nicht gemessen — Amazon bucht Werbeumsatz auf den Tag des " +
      "Klicks; einzelne Tage koennen negativ sein, belastbar ist `woche`. " +
      "`ereignisse` je Produkt nennt, was an welchem Tag passiert ist: Preiswechsel, Listing inaktiv/aktiv, " +
      "Tage ohne FBA-Bestand, Aenderungen am Werbekonto ueber Pulse (Budget, Kampagne pausiert, Negatives, " +
      "Gebote), seit dem 04.10.2026 auch Aenderungen der Helium-10-KI und aus Seller Central (taeglicher " +
      "Struktur-Abgleich). Nicht enthalten: Coupons, Wettbewerber. " +
      "Ein Ereignis am Tag eines Knicks ist ein Hinweis, keine Ursache.",
    inputSchema: {
      type: "object",
      properties: {
        tage: { type: "integer", description: "Laenge des Verlaufs in Tagen, 7 bis 180. Default 42." },
        marktplatz: ADS_ZEITRAUM_SCHEMA.properties.marktplatz,
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_produkt_verlauf", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_ads_kampagnen_ertrag",
    description:
      "Was je Kampagne nach Werbung uebrig bleibt — nur Kampagnen der VERWALTETEN Produkte. Je Kampagne " +
      "Kosten, Werbeumsatz, Bestellungen, ACoS, `break_even_acos` (Marge vor Werbung ihres Produkts, 90 Tage) " +
      "und `db_nach_werbung` (Werbeumsatz x Marge − Kosten), dazu `steuerung` (h10 = Gebote setzt Helium 10, " +
      "pulse) und `einordnung`: traegt_sich, ueber_break_even, ohne_bestellung (ab 20 Klicks), wenig_daten, " +
      "marge_unbekannt. Sortiert nach dem groessten Verlust. `bilanz` fasst zusammen. " +
      "EINORDNUNG: eine Rechnung je Kampagne, kein Urteil. Sie kennt nur den zugeschriebenen Werbeumsatz — " +
      "eine Ranking-Kampagne darf ueber dem Break-even liegen. SB und SD schreiben Umsatz anders zu als SP.",
    inputSchema: {
      type: "object",
      properties: {
        tage: { type: "integer", description: "Fensterlaenge in Tagen, 1 bis 90. Default 30." },
        marktplatz: ADS_ZEITRAUM_SCHEMA.properties.marktplatz,
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("ads_kampagnen_ertrag", args) : pulseNichtVerfuegbar()),
  },
  {
    name: "get_account_health",
    description:
      "Amazons Kontozustand (Account Health) je Marktplatz: Kontostatus, Account-Health-Rating " +
      "(Punkte und Status), Verwarnungen, und alle Leistungs- und Richtlinienkennzahlen — " +
      "Maengelquote je Versandart, verspaetete Sendungen, Stornoquote, puenktliche Lieferung, " +
      "gueltige Sendungsverfolgung, Rechnungsmaengel sowie Verstoesse (Listing-Richtlinien, " +
      "geistiges Eigentum, Produktsicherheit, Echtheit, Zustand, Rezensionen). " +
      "`handlungsbedarf` nennt, wo Amazon etwas anderes als 'in Ordnung' meldet. " +
      "`ziel_verfehlt_trotz_gutem_status` nennt Kennzahlen, deren Wert jenseits von Amazons " +
      "eigenem Ziel liegt, obwohl Amazon GOOD meldet — meist wegen kleiner Mengen (`menge`). " +
      "Amazons `status` entscheidet ueber das Konto, nicht dieser Vergleich. Taeglich gezogen; " +
      "`stand` sagt wann.",
    inputSchema: LEERES_SCHEMA,
    handle: async (_args, ctx) => {
      const row = await ctx.ladeReport("GET_V2_SELLER_PERFORMANCE_REPORT");
      if (!row) return keineDaten("GET_V2_SELLER_PERFORMANCE_REPORT");
      return baueAccountHealth(row.payload as Record<string, any>, row.data_timestamp);
    },
  },
  {
    name: "get_review_themes",
    description:
      "Rezensionsthemen je ASIN aus Amazons Customer-Feedback-API (dieselben Daten wie " +
      "der Product Opportunity Explorer): welche Themen Kunden positiv und negativ nennen, " +
      "mit Nennungen, Einfluss auf die Sternebewertung, Vergleich zur Kategorie und der " +
      "Veraenderung gegenueber dem Vormonat. 'auffaellig' nennt negative Themen, die NEU " +
      "auftauchen oder sich verdoppelt haben — nur ab 5 Nennungen, darunter ist es Zufall. " +
      "Ohne 'asin' die Liste der ASINs, fuer die Daten vorliegen. " +
      "WICHTIG: Themennamen kommen von Amazon auf ENGLISCH, auch fuer Amazon.de. Die Daten " +
      "werden WOECHENTLICH aufgefrischt. Sternezahl, Anzahl der Bewertungen und der " +
      "Wortlaut einzelner Rezensionen sind NICHT enthalten — die gibt keine SP-API her. " +
      "Rezensionen sind je Marktplatz verschieden.",
    inputSchema: {
      type: "object",
      properties: {
        asin: { type: "string", description: "Child-ASIN. Weglassen fuer die Liste der verfuegbaren ASINs." },
        marktplatz: { type: "string", description: "Marketplace-ID. Ohne Angabe der der Verbindung." },
        limit: { type: "number", description: "Hoechstzahl Themen (Standard 50)." },
      },
      additionalProperties: false,
    },
    handle: async (args, ctx) => (ctx.ladePulse ? ctx.ladePulse("reviews", args) : pulseNichtVerfuegbar()),
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
/**
 * Darf dieses Werkzeug in diesem Kontext benutzt werden?
 *
 * Bewusst dieselbe Entscheidung wie im Web (zugriffErlaubt), damit MCP und
 * Oberflaeche nicht auseinanderlaufen koennen. Vorher waren die Tools ueber MCP
 * gar nicht gegated: wer Zugang zur KI-Anbindung hatte, bekam alle Werkzeuge,
 * unabhaengig vom Tarif.
 */
function werkzeugErlaubt(name: string, ctx: McpContext): boolean {
  // features === undefined heisst "nicht geprueft" (Unit-Test, alter Aufrufer)
  // und bleibt offen. Nur ein ausdruecklich uebergebenes Objekt sperrt.
  if (ctx.features === undefined || ctx.features === null) return true;
  return zugriffErlaubt(name, ctx.features, ctx.coach === true);
}

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
      // Werkzeuge, die der Tarif nicht traegt, werden gar nicht erst genannt.
      // Sie trotzdem zu listen hiesse, das Modell in einen Fehlversuch laufen
      // zu lassen — und es wuerde die Antwort mit einer Absage fuellen, statt
      // mit dem, was der Kunde tatsaechlich hat.
      return ergebnis(id, { tools: toolListe().filter((t) => werkzeugErlaubt(t.name, ctx)) });

    case "tools/call": {
      const name = req.params?.name as string | undefined;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return fehler(id, -32602, `Unbekanntes Tool: ${name}`);
      }
      // Zweite Schranke, obwohl tools/list schon filtert: ein Client kann einen
      // Namen aus einer aelteren Sitzung behalten oder raten. Die Liste ist
      // Bequemlichkeit, diese Pruefung ist die Sperre.
      if (!werkzeugErlaubt(tool.name, ctx)) {
        return ergebnis(id, {
          content: [{
            type: "text",
            text: `Das Werkzeug ${tool.name} ist im Tarif dieses Kontos nicht `
              + "enthalten. Die Daten existieren, der Zugang dazu ist nicht "
              + "freigeschaltet — bitte beim Coach nachfragen.",
          }],
          isError: true,
        });
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

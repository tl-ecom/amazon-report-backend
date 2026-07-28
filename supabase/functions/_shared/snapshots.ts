// snapshots.ts — normalisiert den Merchant-Listings-Report in SKU-genaue
// ASIN-Snapshots (append-only, ein Snapshot je SKU/Tag) und pflegt die
// asins-Kernentität. Muster wie history.ts: reine Row-Builder + eine DB-Funktion.
//
// Ehrlichkeit (aus listings.ts übernommen):
//   * quantity: leer -> null (unbekannt; FBA führt Bestand hier nicht), 0 = echt
//     ausverkauft (aktives Merchant-Angebot). NIE leer als 0 werten.
//   * price: Zahl ohne Währung (ergibt sich aus dem Marketplace).
// Diese Snapshots sind die Vergleichsbasis der Change-Engine (Preis/Bestand/
// Status/Fulfillment-Diffs über aufeinanderfolgende Tage).

const LISTINGS = "GET_MERCHANT_LISTINGS_ALL_DATA";

export type Row = Record<string, unknown>;

function istFba(channel: string): boolean {
  return channel.toUpperCase().startsWith("AMAZON");
}

function parsePreis(s: unknown): number | null {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Menge -> Zahl; leer/unlesbar -> null (unbekannt, NICHT 0). */
function parseMenge(s: unknown): number | null {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function txt(v: unknown, max = 200): string | null {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** Listings-Payload -> eine Snapshot-Zeile je SKU (dedupliziert innerhalb des Reports). */
export function baueAsinSnapshotRows(
  tenant_id: string,
  payload: any,
  snapshot_ts: string,
  import_report_id: string | null,
): Row[] {
  const snapshot_date = snapshot_ts.slice(0, 10);
  const proSku = new Map<string, Row>();
  for (const r of payload?.rows ?? []) {
    const sku = String(r["seller-sku"] ?? "").trim();
    if (!sku) continue;
    const channel = String(r["fulfillment-channel"] ?? "").trim();
    proSku.set(sku, {
      tenant_id,
      asin: txt(r["asin1"]),
      seller_sku: sku,
      snapshot_ts,
      snapshot_date,
      import_report_id,
      status: txt(r["status"]),
      fulfillment_channel: channel || null,
      is_fba: channel ? istFba(channel) : null,
      price: parsePreis(r["price"]),
      quantity: parseMenge(r["quantity"]),
      item_name: txt(r["item-name"]),
      is_provisional: false,
      completeness_status: "complete",
      raw: r,
    });
  }
  return [...proSku.values()];
}

/** Listings-Payload -> je distinct ASIN eine asins-Upsert-Zeile. */
export function baueAsinRows(tenant_id: string, marketplace_id: string | null, payload: any): Row[] {
  const proAsin = new Map<string, Row>();
  for (const r of payload?.rows ?? []) {
    const asin = String(r["asin1"] ?? "").trim();
    if (!asin || proAsin.has(asin)) continue;
    proAsin.set(asin, {
      tenant_id,
      marketplace_id,
      asin,
      produktname: txt(r["item-name"]),
      zuletzt_gesehen: new Date().toISOString(),
    });
  }
  return [...proAsin.values()];
}

export interface SnapshotErgebnis {
  tabelle: string | null;
  asins: number;
  snapshots: number;
  fehler?: string;
}

/**
 * Schreibt aus dem Listings-Report die ASIN-Snapshots (SKU-genau) und pflegt die
 * asins-Entität. Andere Report-Typen: no-op (tabelle:null). Upsert je SKU/Tag.
 */
export async function schreibeSnapshots(
  supabase: any,
  tenant_id: string,
  reportType: string,
  payload: any,
  opts: { snapshot_ts?: string; import_report_id?: string | null; marketplace_id?: string | null } = {},
): Promise<SnapshotErgebnis> {
  if (reportType !== LISTINGS) return { tabelle: null, asins: 0, snapshots: 0 };

  const snapshot_ts = opts.snapshot_ts ?? new Date().toISOString();

  // 1) asins-Entität pflegen (erstmals_gesehen bleibt unangetastet — nicht im Upsert).
  const asinRows = baueAsinRows(tenant_id, opts.marketplace_id ?? null, payload);
  if (asinRows.length > 0) {
    const { error } = await supabase.from("asins").upsert(asinRows, { onConflict: "tenant_id,asin" });
    if (error) return { tabelle: "asins", asins: 0, snapshots: 0, fehler: `asins: ${error.message}` };
  }

  // 2) ASIN-Snapshots (SKU/Tag) upserten.
  const snapRows = baueAsinSnapshotRows(tenant_id, payload, snapshot_ts, opts.import_report_id ?? null);
  const BATCH = 500;
  for (let i = 0; i < snapRows.length; i += BATCH) {
    const batch = snapRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("asin_snapshots")
      .upsert(batch, { onConflict: "tenant_id,seller_sku,snapshot_date" });
    if (error) return { tabelle: "asin_snapshots", asins: asinRows.length, snapshots: 0, fehler: `asin_snapshots: ${error.message}` };
  }

  return { tabelle: "asin_snapshots", asins: asinRows.length, snapshots: snapRows.length };
}

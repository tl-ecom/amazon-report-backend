// listings.ts — Aufbereitung des Merchant-Listings-Reports (alle Angebote).
//
// Reines Modul: keine DB, kein Netz. Analog zu metrics.ts / orders.ts.
//
// FALLSTRICK (am echten Konto belegt, 2026-07-17), analog zum leeren Preis bei
// Orders: `quantity` bedeutet je nach `fulfillment-channel` etwas anderes.
//   * DEFAULT (Merchant-Fulfilled): quantity ist der ECHTE Bestand des Sellers.
//     quantity=0 bei einem AKTIVEN Angebot = Out-of-Stock, kann nichts verkaufen.
//   * AMAZON_* (FBA): quantity ist hier LEER — der Bestand liegt im FBA-Lager und
//     steht in GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA (separater Report).
//     Leer heißt "hier nicht geführt", NICHT 0. FBA-Angebote dürfen deshalb NIE
//     aus diesem Report als ausverkauft gewertet werden.
//
// Der Report hat KEINE Währungsspalte. `price` ist eine nackte Zahl; die Währung
// ergibt sich aus dem Marketplace (DE = EUR). Deshalb werden Preise als Zahlen
// ohne Währungsbehauptung ausgegeben.

export interface ListingsOverview {
  data_timestamp: string;
  gesamt: {
    angebote: number;
    aktiv: number;
    inaktiv: number;
    unvollstaendig: number;
    sonstiger_status: number;
  };
  aktive_nach_fulfillment: {
    merchant: number;
    fba: number;
    unbekannt: number;
  };
  bestand_merchant: {
    // NUR Merchant-Angebote — für FBA sagt dieser Report nichts über Bestand.
    aktive_angebote: number;
    ausverkauft: number; // aktiv, quantity=0 → DER Alarm
    einheiten_gesamt: number;
    ausverkaufte_skus: Array<{ sku: string; asin: string; preis: number | null; name: string }>;
  };
  bestand_fba: {
    aktive_angebote: number;
    // Bewusst KEINE Bestandszahl — steht nicht in diesem Report.
    menge_hier_nicht_gefuehrt: number;
  };
  preis_aktiv: { min: number | null; max: number | null; median: number | null; ohne_preis: number };
  warnungen: string[];
  formeln: Record<string, string>;
}

const FORMELN: Record<string, string> = {
  ausverkauft: "aktive Angebote mit fulfillment-channel=DEFAULT (Merchant) UND quantity=0",
  bestand_fba: "FBA-Bestand steht NICHT in diesem Report — separat GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
  preis: "price ist eine Zahl OHNE Währung im Report; Währung ergibt sich aus dem Marketplace (DE=EUR)",
};

function istFba(channel: string): boolean {
  // FBA-Kanäle heißen AMAZON, AMAZON_EU, AMAZON_NA, ... Merchant ist DEFAULT.
  return channel.toUpperCase().startsWith("AMAZON");
}

function parsePreis(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Menge → Zahl, oder null wenn leer/unlesbar. Leer ≠ 0 (siehe Kopf). */
function parseMenge(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function median(werte: number[]): number | null {
  if (werte.length === 0) return null;
  const s = [...werte].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const roh = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round((roh + Number.EPSILON) * 100) / 100;
}

export function baueListingsOverview(
  payload: Record<string, any>,
  data_timestamp: string
): ListingsOverview {
  const rows: Record<string, string>[] = payload?.rows ?? [];

  let aktiv = 0, inaktiv = 0, unvollstaendig = 0, sonstiger = 0;
  let mAktiv = 0, fbaAktiv = 0, unbekanntAktiv = 0;
  let mAusverkauft = 0, mEinheiten = 0, fbaMengeFehlt = 0;
  const ausverkaufteSkus: ListingsOverview["bestand_merchant"]["ausverkaufte_skus"] = [];
  const aktivPreise: number[] = [];
  let ohnePreis = 0;

  for (const r of rows) {
    const status = (r["status"] ?? "").trim();
    const istAktiv = status.toLowerCase() === "active";

    if (istAktiv) aktiv++;
    else if (status.toLowerCase() === "inactive") inaktiv++;
    else if (status.toLowerCase() === "incomplete") unvollstaendig++;
    else sonstiger++;

    if (!istAktiv) continue;

    const channel = (r["fulfillment-channel"] ?? "").trim();
    const menge = parseMenge(r["quantity"]);
    const preis = parsePreis(r["price"]);

    if (preis === null) ohnePreis++;
    else aktivPreise.push(preis);

    if (channel === "" ) {
      unbekanntAktiv++;
    } else if (istFba(channel)) {
      fbaAktiv++;
      if (menge === null) fbaMengeFehlt++; // erwartet — FBA führt Bestand hier nicht
    } else {
      // Merchant (DEFAULT o.ä.)
      mAktiv++;
      if (menge !== null) {
        mEinheiten += menge;
        if (menge === 0) {
          mAusverkauft++;
          if (ausverkaufteSkus.length < 100) {
            ausverkaufteSkus.push({
              sku: (r["seller-sku"] ?? "").trim(),
              asin: (r["asin1"] ?? "").trim(),
              preis,
              name: (r["item-name"] ?? "").trim().slice(0, 80),
            });
          }
        }
      }
    }
  }

  const warnungen: string[] = [];
  if (mAusverkauft > 0) {
    warnungen.push(
      `${mAusverkauft} aktive Merchant-Angebote haben quantity=0 — sie sind live, ` +
        "können aber nichts verkaufen (Out-of-Stock). Siehe bestand_merchant.ausverkaufte_skus."
    );
  }
  if (fbaAktiv > 0) {
    warnungen.push(
      `${fbaAktiv} aktive FBA-Angebote: ihr Bestand steht NICHT in diesem Report. ` +
        "Für FBA-Reichweite den FBA-Inventory-Report separat ziehen (braucht die " +
        "App-Rolle 'Amazon Fulfillment')."
    );
  }

  return {
    data_timestamp,
    gesamt: {
      angebote: rows.length,
      aktiv,
      inaktiv,
      unvollstaendig,
      sonstiger_status: sonstiger,
    },
    aktive_nach_fulfillment: { merchant: mAktiv, fba: fbaAktiv, unbekannt: unbekanntAktiv },
    bestand_merchant: {
      aktive_angebote: mAktiv,
      ausverkauft: mAusverkauft,
      einheiten_gesamt: mEinheiten,
      ausverkaufte_skus: ausverkaufteSkus,
    },
    bestand_fba: { aktive_angebote: fbaAktiv, menge_hier_nicht_gefuehrt: fbaMengeFehlt },
    preis_aktiv: {
      min: aktivPreise.length ? Math.min(...aktivPreise) : null,
      max: aktivPreise.length ? Math.max(...aktivPreise) : null,
      median: median(aktivPreise),
      ohne_preis: ohnePreis,
    },
    warnungen,
    formeln: FORMELN,
  };
}

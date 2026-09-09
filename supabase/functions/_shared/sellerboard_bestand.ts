// sellerboard_bestand.ts — Parser fuer den Sellerboard-Bestands-Export
// (Automation -> „Export: Lagerbestand" / Inventory).
//
// Warum: Amazon kennt nur den Bestand, der bei Amazon liegt (FBA, Inbound).
// Was im eigenen Lager, beim Logistiker, im Prep Center oder beim Lieferanten
// steht, weiss nur der Verkaeufer — und viele pflegen genau das in Sellerboard.
// Ohne diese Mengen rechnen Nachschub, Reichweite und Kapitalbindung nur mit
// dem, was Amazon sieht.
//
// Der Parser erkennt die Spalten DYNAMISCH: Sellerboard-Exporte unterscheiden
// sich je Konto und Sprache, und welche Lagerorte ein Konto nutzt, ist frei
// konfigurierbar. Jede Spalte wird einer Lagerart zugeordnet — oder ausdruecklich
// als „nicht erkannt" gemeldet. Es wird NICHTS still geraten: eine unbekannte
// Zahlenspalte wird benannt, nicht importiert.
//
// Rein: kein Netz, keine Datenbank. Getestet in sellerboard_bestand_test.ts.

import { csvZeilen, erkenneTrenner } from "./sellerboard.ts";

/**
 * Lagerarten, die Pulse unterscheidet. Die Klasse entscheidet, wie die Menge
 * in die Bestandslogik eingeht:
 *
 *   amazon          — liegt bei Amazon bzw. ist zu Amazon unterwegs. Dafuer ist
 *                     die SP-API die PRIMAERE Quelle. Sellerboard-Werte dieser
 *                     Klasse werden nur dann gezaehlt, wenn Amazon fuer den
 *                     Mandanten GAR KEINE Bestandsdaten liefert — sonst kaeme
 *                     derselbe Bestand doppelt vor.
 *   physisch_extern — physisch vorhanden, aber nicht bei Amazon: eigenes Lager,
 *                     Prep Center, Logistiker. Kann kurzfristig angeliefert werden.
 *   pipeline        — noch nicht greifbar: bestellt, unterwegs, AWD. AWD zaehlt
 *                     bewusst zur Pipeline: die Ware liegt zwar bei Amazon, ist
 *                     aber erst verkaufsfaehig, wenn sie ins FBA-Netz uebergeht.
 */
export type Lagerart =
  | "fba_verfuegbar"
  | "fba_reserviert"
  | "fba_unverkaeuflich"
  | "inbound_fba"
  | "awd"
  | "prep_center"
  | "extern_lager"
  | "dreipl"
  | "ordered"
  | "sonstige_pipeline";

export type Klasse = "amazon" | "physisch_extern" | "pipeline";

export const KLASSE: Record<Lagerart, Klasse> = {
  fba_verfuegbar: "amazon",
  fba_reserviert: "amazon",
  fba_unverkaeuflich: "amazon",
  inbound_fba: "amazon",
  awd: "pipeline",
  prep_center: "physisch_extern",
  extern_lager: "physisch_extern",
  dreipl: "physisch_extern",
  ordered: "pipeline",
  sonstige_pipeline: "pipeline",
};

export const LAGERART_LABEL: Record<Lagerart, string> = {
  fba_verfuegbar: "FBA verfügbar",
  fba_reserviert: "FBA reserviert",
  fba_unverkaeuflich: "FBA unverkäuflich",
  inbound_fba: "Amazon Inbound",
  awd: "AWD",
  prep_center: "Prep Center / Zwischenlager",
  extern_lager: "Eigenes Lager",
  dreipl: "3PL / Logistiker",
  ordered: "Bestellt (Lieferant)",
  sonstige_pipeline: "Sonstige Pipeline",
};

export type SpaltenRolle =
  | { rolle: "sku" }
  | { rolle: "asin" }
  | { rolle: "marktplatz" }
  | { rolle: "produktname" }
  | { rolle: "ort" }          // Langformat: Name des Lagerorts je Zeile
  | { rolle: "menge" }        // Langformat: Menge je Zeile
  | { rolle: "bestand"; lagerart: Lagerart }
  | { rolle: "ignorieren"; grund: string }
  | { rolle: "unbekannt" };

/** Spaltennamen normalisieren: Gross/Klein, Umlaute, Trennzeichen egal. */
export function norm(s: string): string {
  return String(s ?? "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

const hat = (n: string, ...teile: string[]) => teile.some((t) => n.includes(t));
const ist = (n: string, ...genau: string[]) => genau.includes(n);

/**
 * Eine Spaltenueberschrift einer Rolle zuordnen.
 *
 * Reihenfolge ist Absicht: Erst Kennungen, dann alles, was KEINE Menge ist
 * (Preise, Tage, Empfehlungen), dann die spezifischen Lagerarten, zuletzt die
 * allgemeinen Begriffe. „Reorder quantity" enthaelt „order", ist aber eine
 * Empfehlung und kein Bestand — deshalb die Ausschluesse vor den Lagerarten.
 */
export function klassifiziereSpalte(kopf: string): SpaltenRolle {
  const n = norm(kopf);
  if (!n) return { rolle: "ignorieren", grund: "leer" };

  // --- Kennungen ---------------------------------------------------------
  if (ist(n, "sku", "sellersku", "merchantsku", "msku", "artikelnummer", "skuhandler")) return { rolle: "sku" };
  if (ist(n, "asin", "asin1", "childasin")) return { rolle: "asin" };
  if (ist(n, "marketplace", "marktplatz", "market", "country", "land", "region", "shop", "store", "account", "konto")) {
    return { rolle: "marktplatz" };
  }
  if (ist(n, "title", "titel", "product", "produkt", "productname", "produktname", "name", "item", "artikel", "bezeichnung", "produkttitel")) {
    return { rolle: "produktname" };
  }

  // --- Langformat: Ort + Menge --------------------------------------------
  if (ist(n, "location", "lagerort", "warehousename", "lagername", "stocktype", "bestandsart", "lagerart", "type", "typ", "storage", "ort", "standort", "source", "quelle")) {
    return { rolle: "ort" };
  }
  if (ist(n, "quantity", "qty", "menge", "anzahl", "units", "stueck", "einheiten", "amount")) {
    return { rolle: "menge" };
  }

  // --- Bestellte Ware VOR den Ausschluessen: „Purchase orders" enthaelt „orders"
  // (Verkaufskennzahl), ist aber eine Bestellung beim Lieferanten. Empfehlungen
  // („Reorder", „Restock") bleiben trotzdem draussen.
  if (
    hat(n, "purchaseorder", "onorder", "openpo", "bestellt", "supplier", "lieferant", "offenebestellung") &&
    !hat(n, "recommend", "empfehl", "reorder", "restock", "suggest", "vorschlag", "date", "datum", "cost", "kosten", "price", "preis")
  ) {
    return { rolle: "bestand", lagerart: "ordered" };
  }

  // --- Keine Mengen: Geld, Zeit, Empfehlungen, Stammdaten --------------------
  if (hat(n, "price", "preis", "cost", "kosten", "cogs", "value", "wert", "revenue", "umsatz", "profit", "gewinn", "margin", "marge", "fee", "gebuehr", "eur", "usd", "currency", "waehrung")) {
    return { rolle: "ignorieren", grund: "Geldbetrag" };
  }
  if (hat(n, "days", "tage", "date", "datum", "velocity", "geschwindigkeit", "perday", "protag", "leadtime", "lieferzeit", "coverage", "reichweite", "supply")) {
    return { rolle: "ignorieren", grund: "Zeit/Geschwindigkeit" };
  }
  if (hat(n, "recommend", "empfehl", "restock", "reorder", "needed", "bedarf", "forecast", "prognose", "suggest", "vorschlag", "target", "ziel", "min", "max")) {
    return { rolle: "ignorieren", grund: "Empfehlung/Planwert" };
  }
  if (hat(n, "sales", "sold", "verkauft", "verkaeufe", "orders", "bestellungen", "sessions", "clicks", "klicks", "impressions")) {
    return { rolle: "ignorieren", grund: "Verkaufskennzahl" };
  }
  if (hat(n, "fnsku", "ean", "upc", "gtin", "barcode", "image", "bild", "url", "link", "brand", "marke", "category", "kategorie", "weight", "gewicht", "size", "groesse", "note", "notiz", "comment", "kommentar", "status", "parent", "variation", "tag", "label")) {
    return { rolle: "ignorieren", grund: "Stammdatum" };
  }
  if (hat(n, "total", "gesamt", "summe", "sum")) {
    // Eine Summenspalte zaehlt Bestaende doppelt, die schon einzeln dastehen.
    return { rolle: "ignorieren", grund: "Summe (wuerde doppelt zaehlen)" };
  }

  // --- Lagerarten, spezifisch zuerst ------------------------------------------
  if (hat(n, "awd", "amazonwarehousing", "warehousinganddistribution")) return { rolle: "bestand", lagerart: "awd" };
  if (hat(n, "prep", "zwischenlager", "vorbereitung")) return { rolle: "bestand", lagerart: "prep_center" };
  if (hat(n, "3pl", "logistik", "logist", "fulfillmentpartner", "thirdparty", "dienstleister", "spedition")) {
    return { rolle: "bestand", lagerart: "dreipl" };
  }
  if (hat(n, "reserv")) return { rolle: "bestand", lagerart: "fba_reserviert" };
  if (hat(n, "unsellable", "unverkaeuflich", "defect", "defekt", "damaged", "beschaedigt")) {
    return { rolle: "bestand", lagerart: "fba_unverkaeuflich" };
  }
  if (hat(n, "purchaseorder", "ordered", "onorder", "bestellt", "supplier", "lieferant", "offenebestellung", "openpo") || ist(n, "po", "pos", "order")) {
    return { rolle: "bestand", lagerart: "ordered" };
  }
  if (hat(n, "inbound", "senttofba", "sentfba", "sendtofba", "shipped", "receiving", "working", "zufba", "anamazon", "eingehend", "anlieferung", "wareneingang")) {
    return { rolle: "bestand", lagerart: "inbound_fba" };
  }
  if (hat(n, "transit", "unterwegs", "transfer", "umlagerung", "pipeline", "incoming")) {
    // „In transit" ohne Amazon-Bezug ist Ware zwischen Lieferant und Lager —
    // Pipeline, aber kein Amazon-Inbound (das hiesse sonst: Amazon empfaengt sie).
    return hat(n, "fba", "amazon")
      ? { rolle: "bestand", lagerart: "inbound_fba" }
      : { rolle: "bestand", lagerart: "sonstige_pipeline" };
  }
  if (hat(n, "warehouse", "eigeneslager", "ownstock", "own", "eigen", "local", "lokal", "external", "extern", "home", "office", "buero")) {
    return { rolle: "bestand", lagerart: "extern_lager" };
  }
  if (hat(n, "fba", "fulfillable", "amazon", "afn")) return { rolle: "bestand", lagerart: "fba_verfuegbar" };
  if (ist(n, "stock", "bestand", "available", "verfuegbar", "lagerbestand", "lager", "inventory", "onhand", "instock")) {
    // Nackte Bestandsspalte: in Sellerboard der FBA-Bestand. Ist Amazon-Klasse
    // und wird deshalb nie doppelt gezaehlt, wenn die SP-API liefert.
    return { rolle: "bestand", lagerart: "fba_verfuegbar" };
  }
  if (hat(n, "lager", "stock", "bestand")) return { rolle: "bestand", lagerart: "extern_lager" };

  return { rolle: "unbekannt" };
}

/**
 * Wert eines Lagerort-Felds (Langformat) einer Lagerart zuordnen. Dieselbe
 * Logik wie fuer Spaltennamen — ein Ort „Prep Center Berlin" ist ein Prep Center.
 * Unbekannte Orte werden als eigenes Lager gefuehrt: Ein Ort, den der Verkaeufer
 * selbst benannt hat, ist physisch vorhandene Ware ausserhalb Amazons.
 */
export function klassifiziereOrt(ort: string): Lagerart {
  const r = klassifiziereSpalte(ort);
  if (r.rolle === "bestand") return r.lagerart;
  const n = norm(ort);
  if (hat(n, "fba", "amazon")) return "fba_verfuegbar";
  return "extern_lager";
}

/**
 * Ganze Stueckzahl aus einem Feld. "1.350" (deutsch) und "1,350" (englisch)
 * sind beide 1350: Bei genau einem Trennzeichen mit drei Folgeziffern ist es
 * ein Tausendertrenner — Stueckzahlen haben keine drei Nachkommastellen.
 * Leer oder unlesbar -> null (UNBEKANNT, nicht 0).
 */
export function mengeGanz(roh: unknown): number | null {
  if (roh === null || roh === undefined) return null;
  let t = String(roh).trim();
  if (t === "" || t === "-" || t === "—") return null;
  t = t.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(t)) return null;

  const hatKomma = t.includes(",");
  const hatPunkt = t.includes(".");
  if (hatKomma && hatPunkt) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (hatKomma || hatPunkt) {
    const sep = hatKomma ? "," : ".";
    const teile = t.split(sep);
    if (teile.length === 2 && /^\d{3}$/.test(teile[1]) && /^-?\d+$/.test(teile[0])) {
      t = teile[0] + teile[1];   // genau ein Trenner + drei Ziffern: Tausender
    } else if (teile.length > 2) {
      t = teile.join("");        // "1.234.567": mehrere Tausendertrenner
    } else {
      t = teile.join(".");       // Dezimaltrenner
    }
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

// --- Marktplatz -------------------------------------------------------------

const DOMAIN_ZU_ID: Record<string, string> = {
  "amazon.de": "A1PA6795UKMFR9",
  "amazon.co.uk": "A1F83G8C2ARO7P",
  "amazon.fr": "A13V1IB3VIYZZH",
  "amazon.it": "APJ6JRA9NG5V4",
  "amazon.es": "A1RKKUPIHCS9HS",
  "amazon.nl": "A1805IZSGTT6HS",
  "amazon.com.be": "AMEN7PMS3EDWL",
  "amazon.se": "A2NODRKZP88ZB9",
  "amazon.pl": "A1C3SOZRARQ6R3",
  "amazon.ie": "A28R8C7NBKEWEA",
  "amazon.com.tr": "A33AVAJ2PDY3EV",
  "amazon.com": "ATVPDKIKX0DER",
  "amazon.ca": "A2EUQ1WTGCTBG2",
  "amazon.com.mx": "A1AM78C64UM0Y8",
  "amazon.co.jp": "A1VC38T7YXB528",
  "amazon.com.au": "A39IBJ37TRP1C6",
  "amazon.ae": "A2VIGQ35RCS4UG",
  "amazon.in": "A21TJRUUN4KGV",
  "amazon.sg": "A19VAU5U5O7RUS",
  "amazon.sa": "A17E79C6D8DWNP",
  "amazon.eg": "ARBP9OOSHTCHU",
};

const LAND_ZU_DOMAIN: Record<string, string> = {
  de: "amazon.de", germany: "amazon.de", deutschland: "amazon.de",
  uk: "amazon.co.uk", gb: "amazon.co.uk", unitedkingdom: "amazon.co.uk",
  fr: "amazon.fr", france: "amazon.fr", frankreich: "amazon.fr",
  it: "amazon.it", italy: "amazon.it", italien: "amazon.it",
  es: "amazon.es", spain: "amazon.es", spanien: "amazon.es",
  nl: "amazon.nl", netherlands: "amazon.nl", niederlande: "amazon.nl",
  be: "amazon.com.be", belgium: "amazon.com.be", belgien: "amazon.com.be",
  se: "amazon.se", sweden: "amazon.se", schweden: "amazon.se",
  pl: "amazon.pl", poland: "amazon.pl", polen: "amazon.pl",
  ie: "amazon.ie", ireland: "amazon.ie", irland: "amazon.ie",
  tr: "amazon.com.tr", turkey: "amazon.com.tr",
  us: "amazon.com", usa: "amazon.com", unitedstates: "amazon.com",
  ca: "amazon.ca", canada: "amazon.ca", kanada: "amazon.ca",
  mx: "amazon.com.mx", mexico: "amazon.com.mx",
  jp: "amazon.co.jp", japan: "amazon.co.jp",
  au: "amazon.com.au", australia: "amazon.com.au",
  ae: "amazon.ae", in: "amazon.in", sg: "amazon.sg", sa: "amazon.sa", eg: "amazon.eg",
};

/**
 * Marktplatz-ID aus dem, was der Feed liefert: Domain („amazon.de"), Laendercode
 * („DE"), Landesname oder bereits eine ID. null, wenn nicht eindeutig — dann
 * bleibt der Rohwert stehen und wird nicht geraten.
 */
export function marktplatzId(roh: unknown): string | null {
  const t = String(roh ?? "").trim();
  if (!t) return null;
  if (/^A[0-9A-Z]{12,13}$/.test(t)) return t;
  const klein = t.toLowerCase().replace(/^www\./, "");
  if (DOMAIN_ZU_ID[klein]) return DOMAIN_ZU_ID[klein];
  const domain = Object.keys(DOMAIN_ZU_ID).find((d) => klein.includes(d));
  if (domain) return DOMAIN_ZU_ID[domain];
  const land = LAND_ZU_DOMAIN[norm(t)];
  return land ? DOMAIN_ZU_ID[land] : null;
}

// --- Parser ------------------------------------------------------------------

export interface BestandZeile {
  sku: string | null;
  asin: string | null;
  marktplatz_roh: string;         // '' wenn der Feed keinen nennt
  marketplace_id: string | null;
  produktname: string | null;
  lagerart: Lagerart;
  lagername: string;              // Spaltenname (Breitformat) bzw. Ort (Langformat)
  menge: number | null;           // null = Feld leer (unbekannt)
}

export interface SpaltenErkennung {
  format: "breit" | "lang" | "unbrauchbar";
  sku: string | null;
  asin: string | null;
  marktplatz: string | null;
  produktname: string | null;
  /** Breitformat: Spaltenname -> Lagerart. */
  bestand: Array<{ spalte: string; lagerart: Lagerart; klasse: Klasse }>;
  /** Langformat: welche Spalten Ort und Menge tragen. */
  ort: string | null;
  menge: string | null;
  ignoriert: Array<{ spalte: string; grund: string }>;
  /** Spalten, die der Parser nicht einordnen konnte. Werden NICHT importiert. */
  nicht_erkannt: string[];
}

export interface BestandParseErgebnis {
  zeilen: BestandZeile[];
  erkannt: SpaltenErkennung;
  spalten: string[];
  /** Datenzeilen ohne SKU und ASIN — uebersprungen, nicht geraten. */
  uebersprungen: number;
  warnungen: string[];
}

export function erkenneSpalten(kopf: string[]): SpaltenErkennung {
  const e: SpaltenErkennung = {
    format: "unbrauchbar", sku: null, asin: null, marktplatz: null, produktname: null,
    bestand: [], ort: null, menge: null, ignoriert: [], nicht_erkannt: [],
  };
  for (const roh of kopf) {
    const spalte = String(roh ?? "").trim();
    const r = klassifiziereSpalte(spalte);
    switch (r.rolle) {
      case "sku": if (!e.sku) e.sku = spalte; else e.ignoriert.push({ spalte, grund: "zweite SKU-Spalte" }); break;
      case "asin": if (!e.asin) e.asin = spalte; else e.ignoriert.push({ spalte, grund: "zweite ASIN-Spalte" }); break;
      case "marktplatz": if (!e.marktplatz) e.marktplatz = spalte; else e.ignoriert.push({ spalte, grund: "zweite Marktplatz-Spalte" }); break;
      case "produktname": if (!e.produktname) e.produktname = spalte; else e.ignoriert.push({ spalte, grund: "zweite Namensspalte" }); break;
      case "ort": if (!e.ort) e.ort = spalte; else e.ignoriert.push({ spalte, grund: "zweite Ortsspalte" }); break;
      case "menge": if (!e.menge) e.menge = spalte; else e.ignoriert.push({ spalte, grund: "zweite Mengenspalte" }); break;
      case "bestand": e.bestand.push({ spalte, lagerart: r.lagerart, klasse: KLASSE[r.lagerart] }); break;
      case "ignorieren": if (r.grund !== "leer") e.ignoriert.push({ spalte, grund: r.grund }); break;
      case "unbekannt": e.nicht_erkannt.push(spalte); break;
    }
  }

  // Langformat: Ort + Menge und keine Lagerart-Spalten. Eine einzelne
  // Mengenspalte OHNE Ort ist dagegen der nackte FBA-Bestand.
  if (e.ort && e.menge && e.bestand.length === 0) e.format = "lang";
  else if (e.bestand.length > 0) {
    e.format = "breit";
    if (e.menge) {
      e.bestand.push({ spalte: e.menge, lagerart: "fba_verfuegbar", klasse: "amazon" });
      e.menge = null;
    }
  } else if (e.menge && !e.ort) {
    e.format = "breit";
    e.bestand.push({ spalte: e.menge, lagerart: "fba_verfuegbar", klasse: "amazon" });
    e.menge = null;
  }
  if (!e.sku && !e.asin) e.format = "unbrauchbar";
  return e;
}

/** Parst einen Sellerboard-Bestands-Export. Rein — kein Netzwerk, keine DB. */
export function parseBestandCsv(text: string): BestandParseErgebnis {
  const leerErk = erkenneSpalten([]);
  const leer: BestandParseErgebnis = { zeilen: [], erkannt: leerErk, spalten: [], uebersprungen: 0, warnungen: [] };
  if (!text || !text.trim()) return { ...leer, warnungen: ["Der Feed ist leer."] };

  const ersteZeile = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  const trenner = erkenneTrenner(ersteZeile);
  const alle = csvZeilen(text, trenner);
  if (alle.length < 1) return { ...leer, warnungen: ["Keine Kopfzeile gefunden."] };

  const kopf = alle[0].map((h) => h.trim());
  const erkannt = erkenneSpalten(kopf);
  const warnungen: string[] = [];

  if (!erkannt.sku && !erkannt.asin) {
    warnungen.push(`Weder SKU- noch ASIN-Spalte erkannt. Gefundene Spalten: ${kopf.join(", ")}`);
    return { ...leer, erkannt, spalten: kopf, warnungen };
  }
  if (erkannt.format === "unbrauchbar") {
    warnungen.push(`Keine Bestandsspalte erkannt. Gefundene Spalten: ${kopf.join(", ")}`);
    return { ...leer, erkannt, spalten: kopf, warnungen };
  }
  if (alle.length < 2) {
    warnungen.push("Keine Datenzeilen gefunden (nur Kopfzeile?).");
    return { ...leer, erkannt, spalten: kopf, warnungen };
  }
  if (erkannt.nicht_erkannt.length > 0) {
    warnungen.push(
      `${erkannt.nicht_erkannt.length} Spalte(n) nicht zugeordnet und deshalb nicht importiert: ${erkannt.nicht_erkannt.join(", ")}`,
    );
  }

  const idx = (name: string | null) => (name ? kopf.indexOf(name) : -1);
  const iSku = idx(erkannt.sku);
  const iAsin = idx(erkannt.asin);
  const iMp = idx(erkannt.marktplatz);
  const iName = idx(erkannt.produktname);
  const iOrt = idx(erkannt.ort);
  const iMenge = idx(erkannt.menge);
  const bestandIdx = erkannt.bestand.map((b) => ({ ...b, i: kopf.indexOf(b.spalte) }));

  const zeilen: BestandZeile[] = [];
  let uebersprungen = 0;
  let unbekannteMarktplaetze = 0;

  for (let r = 1; r < alle.length; r++) {
    const z = alle[r];
    const sku = iSku >= 0 ? (z[iSku] ?? "").trim() : "";
    const asinRoh = iAsin >= 0 ? (z[iAsin] ?? "").trim().toUpperCase() : "";
    const asin = /^[A-Z0-9]{10}$/.test(asinRoh) ? asinRoh : "";
    if (!sku && !asin) { uebersprungen++; continue; }

    const mpRoh = iMp >= 0 ? (z[iMp] ?? "").trim() : "";
    const mpId = mpRoh ? marktplatzId(mpRoh) : null;
    if (mpRoh && !mpId) unbekannteMarktplaetze++;
    const name = iName >= 0 ? (z[iName] ?? "").trim() || null : null;

    const basis = { sku: sku || null, asin: asin || null, marktplatz_roh: mpRoh, marketplace_id: mpId, produktname: name };

    if (erkannt.format === "lang") {
      const ort = (z[iOrt] ?? "").trim();
      if (!ort) { uebersprungen++; continue; }
      zeilen.push({ ...basis, lagerart: klassifiziereOrt(ort), lagername: ort, menge: mengeGanz(z[iMenge]) });
      continue;
    }
    for (const b of bestandIdx) {
      if (b.i < 0) continue;
      zeilen.push({ ...basis, lagerart: b.lagerart, lagername: b.spalte, menge: mengeGanz(z[b.i]) });
    }
  }

  if (unbekannteMarktplaetze > 0) {
    warnungen.push(
      `${unbekannteMarktplaetze} Zeile(n) mit nicht zuordenbarem Marktplatz — der Rohwert wird gespeichert, die Amazon-Marktplatz-ID bleibt leer.`,
    );
  }
  if (zeilen.length === 0) warnungen.push("Keine verwertbare Zeile gefunden (SKU/ASIN fehlt ueberall?).");

  return { zeilen, erkannt, spalten: kopf, uebersprungen, warnungen };
}

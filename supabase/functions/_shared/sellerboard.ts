// sellerboard.ts — Import der Einkaufspreise (EK) aus einem Sellerboard-Export.
//
// Warum: Den EK kennt nur der Verkäufer, Amazon liefert ihn nie. Viele pflegen
// ihn bereits in Sellerboard („Export: Einkaufspreise", CSV per Link oder Datei).
// Ohne EK bleibt der Nettogewinn je Produkt leer.
//
// Der Parser ist BEWUSST tolerant: Spaltennamen, Trennzeichen und Zahlenformat
// unterscheiden sich je Konto/Sprache. Er meldet zurück, welche Spalten er
// erkannt hat und was er übersprungen hat — nichts wird still geraten.

export interface EkZeile {
  sku: string | null;
  asin: string | null;
  ek_cents: number;
  gueltig_ab: string | null; // 'YYYY-MM-DD' oder null (= Aufrufer setzt Default)
}

export interface EkParseErgebnis {
  zeilen: EkZeile[];
  /** Welche Quellspalte wurde wofür benutzt? Macht den Import überprüfbar. */
  erkannt: { sku: string | null; asin: string | null; ek: string | null; datum: string | null };
  /** Kopfzeile im Original — hilft beim Nachbessern, wenn etwas fehlt. */
  spalten: string[];
  uebersprungen: number;
  warnungen: string[];
}

/** Spaltennamen normalisieren: Groß/Klein, Umlaute, Trennzeichen egal. */
function norm(s: string): string {
  return s.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

// Kandidaten je Feld, beste zuerst. Deutsch UND Englisch, weil der Export je
// nach Kontosprache anders heißt.
const SPALTEN = {
  sku: ["sku", "sellersku", "merchantsku", "artikelnummer", "msku"],
  asin: ["asin", "asin1"],
  ek: [
    "einkaufspreis", "einkaufspreise", "ek", "stueckkosten", "kosten", "warenkosten",
    "cost", "productcost", "unitcost", "cogs", "purchaseprice", "costofgoods",
  ],
  datum: ["gueltigab", "datum", "date", "startdate", "gueltigab", "validfrom", "von"],
};

/** Findet den Index der ersten passenden Spalte. */
function findeSpalte(kopf: string[], kandidaten: string[]): number {
  const normiert = kopf.map(norm);
  for (const k of kandidaten) {
    const i = normiert.indexOf(k);
    if (i >= 0) return i;
  }
  // Zweite Runde: Teiltreffer (z. B. "einkaufspreis netto").
  for (const k of kandidaten) {
    const i = normiert.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

/** Trennzeichen aus der Kopfzeile raten: das häufigste außerhalb von Anführungszeichen. */
export function erkenneTrenner(kopfzeile: string): string {
  const kandidaten = [";", ",", "\t", "|"];
  let bestes = ",";
  let max = 0;
  for (const t of kandidaten) {
    const n = kopfzeile.split(t).length - 1;
    if (n > max) { max = n; bestes = t; }
  }
  return bestes;
}

/** Minimaler CSV-Parser mit Anführungszeichen ("" = escaptes Zeichen). */
export function csvZeilen(text: string, trenner: string): string[][] {
  const raus: string[][] = [];
  let feld = "";
  let zeile: string[] = [];
  let inQuote = false;
  const s = text.replace(/^﻿/, ""); // BOM weg

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '"') {
        if (s[i + 1] === '"') { feld += '"'; i++; }
        else inQuote = false;
      } else feld += c;
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === trenner) { zeile.push(feld); feld = ""; continue; }
    if (c === "\n") {
      zeile.push(feld); feld = "";
      if (zeile.some((f) => f.trim() !== "")) raus.push(zeile);
      zeile = [];
      continue;
    }
    if (c === "\r") continue;
    feld += c;
  }
  zeile.push(feld);
  if (zeile.some((f) => f.trim() !== "")) raus.push(zeile);
  return raus;
}

/**
 * Geldbetrag -> ganze Cent. Beherrscht "12,34", "12.34", "1.234,56", "1,234.56",
 * "€ 12,34". Leer/unlesbar -> null (NICHT 0 — ein fehlender EK ist unbekannt).
 */
export function ekCents(roh: unknown): number | null {
  if (roh === null || roh === undefined) return null;
  let t = String(roh).trim();
  if (t === "") return null;
  t = t.replace(/[^\d.,-]/g, "");
  if (t === "" || t === "-") return null;

  const hatKomma = t.includes(",");
  const hatPunkt = t.includes(".");
  if (hatKomma && hatPunkt) {
    // Das WEITER RECHTS stehende Zeichen ist das Dezimaltrennzeichen.
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (hatKomma) {
    // "1,234" ist mehrdeutig; Sellerboard exportiert Dezimalkomma -> so lesen.
    t = t.replace(",", ".");
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * 'YYYY-MM-DD' aus gängigen Formaten (ISO, 31.12.2026, 12/31/2026).
 * null wenn unklar ODER unplausibel: Sellerboard exportiert bei fehlendem
 * Startdatum "31.12.1969" (Unix-Epoch-Artefakt). Das ist KEIN echtes Datum —
 * es als solches zu übernehmen würde eine Preisperiode vortäuschen.
 */
export const FRUEHESTES_JAHR = 2000;

export function datumIso(roh: unknown): string | null {
  const t = String(roh ?? "").trim();
  if (t === "") return null;
  let iso: string | null = null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (!iso) {
    m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); // deutsch
    if (m) iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if (!iso) {
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // US
    if (m) iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  if (!iso) return null;
  return Number(iso.slice(0, 4)) < FRUEHESTES_JAHR ? null : iso;
}

/** Parst einen Sellerboard-EK-Export. Rein — kein Netzwerk, keine DB. */
export function parseEkCsv(text: string): EkParseErgebnis {
  const leer: EkParseErgebnis = {
    zeilen: [], erkannt: { sku: null, asin: null, ek: null, datum: null },
    spalten: [], uebersprungen: 0, warnungen: [],
  };
  if (!text || !text.trim()) {
    return { ...leer, warnungen: ["Die Datei ist leer."] };
  }

  const ersteZeile = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  const trenner = erkenneTrenner(ersteZeile);
  const alle = csvZeilen(text, trenner);
  if (alle.length < 2) {
    return { ...leer, spalten: alle[0] ?? [], warnungen: ["Keine Datenzeilen gefunden (nur Kopfzeile?)."] };
  }

  const kopf = alle[0].map((h) => h.trim());
  const iSku = findeSpalte(kopf, SPALTEN.sku);
  const iAsin = findeSpalte(kopf, SPALTEN.asin);
  const iEk = findeSpalte(kopf, SPALTEN.ek);
  const iDatum = findeSpalte(kopf, SPALTEN.datum);

  const erkannt = {
    sku: iSku >= 0 ? kopf[iSku] : null,
    asin: iAsin >= 0 ? kopf[iAsin] : null,
    ek: iEk >= 0 ? kopf[iEk] : null,
    datum: iDatum >= 0 ? kopf[iDatum] : null,
  };
  const warnungen: string[] = [];

  if (iEk < 0) {
    warnungen.push(`Keine Einkaufspreis-Spalte erkannt. Gefundene Spalten: ${kopf.join(", ")}`);
    return { ...leer, spalten: kopf, erkannt, warnungen };
  }
  if (iSku < 0 && iAsin < 0) {
    warnungen.push(`Weder SKU- noch ASIN-Spalte erkannt. Gefundene Spalten: ${kopf.join(", ")}`);
    return { ...leer, spalten: kopf, erkannt, warnungen };
  }
  if (iDatum < 0) {
    warnungen.push("Keine Datumsspalte erkannt — die Preise gelten dann fuer alle Bestellungen.");
  }

  const zeilen: EkZeile[] = [];
  let uebersprungen = 0;
  for (let r = 1; r < alle.length; r++) {
    const z = alle[r];
    const sku = iSku >= 0 ? (z[iSku] ?? "").trim() : "";
    const asin = iAsin >= 0 ? (z[iAsin] ?? "").trim() : "";
    const cents = ekCents(iEk >= 0 ? z[iEk] : null);
    // Ohne Kennung oder ohne lesbaren Preis: überspringen statt raten.
    if ((!sku && !asin) || cents === null || cents <= 0) { uebersprungen++; continue; }
    zeilen.push({
      sku: sku || null,
      asin: asin || null,
      ek_cents: cents,
      gueltig_ab: iDatum >= 0 ? datumIso(z[iDatum]) : null,
    });
  }

  if (zeilen.length === 0) warnungen.push("Keine verwertbare Zeile gefunden (Preis fehlt oder ist 0).");
  return { zeilen, erkannt, spalten: kopf, uebersprungen, warnungen };
}

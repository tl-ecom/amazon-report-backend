// sellerboard_abgleich.ts — monatliche Gegenprobe gegen Sellerboard.
//
// Pulse rechnet Umsatz, Gebühren, Werbung und Steuer aus Amazons Rohdaten.
// Sellerboard rechnet dieselben Größen aus denselben Quellen, aber mit eigener
// Logik. Weichen beide stark ab, stimmt bei einem von beiden etwas nicht — und
// das fällt sonst erst auf, wenn jemand zufällig hinsieht.
//
// Wie nötig das ist, zeigte der erste Abgleich selbst: Pulse rechnete die
// Auszahlungsquote mit 33 %, Sellerboard wies 46 % aus. Umsatz und Einheiten
// stimmten dagegen auf unter einem Prozent überein. Ohne die Gegenprobe wäre
// der Fehler in der Cash-Prognose stehen geblieben.
//
// Die Prüfung ist ausdrücklich KEIN Beweis, dass Sellerboard recht hat. Sie
// meldet nur, dass zwei unabhängige Rechnungen auseinanderlaufen — welche
// falsch liegt, muss ein Mensch entscheiden. Deshalb heißt das Ergebnis
// "Abweichung" und nicht "Fehler".

/** Ab hier ist eine Abweichung erklärungsbedürftig. */
export const ABWEICHUNG_WARN = 0.05;
/** Ab hier stimmt mit hoher Wahrscheinlichkeit etwas nicht. */
export const ABWEICHUNG_STARK = 0.15;

export type Bewertung = "ok" | "abweichung" | "stark" | "nicht_pruefbar";

export interface Befund {
  kennzahl: string;
  pulse_cents: number | null;
  sellerboard_cents: number | null;
  abweichung_prozent: number | null;
  bewertung: Bewertung;
  /** Ein Satz für den Leser, wenn es nicht "ok" ist. */
  hinweis: string | null;
}

// --- CSV --------------------------------------------------------------------

/**
 * Zerlegt eine CSV-Zeile mit Anführungszeichen.
 * Sellerboards Export quotet ALLE Felder und nutzt deutsche Zahlen
 * ("39163,33") — beides muss hier hindurch, ohne dass ein Komma im Zahlenwert
 * als Trenner gelesen wird.
 */
export function csvZeile(zeile: string): string[] {
  const felder: string[] = [];
  let feld = "";
  let inAnfuehrung = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (c === '"') {
      // Doppeltes Anführungszeichen innerhalb eines Feldes = ein echtes.
      if (inAnfuehrung && zeile[i + 1] === '"') { feld += '"'; i++; }
      else inAnfuehrung = !inAnfuehrung;
    } else if (c === "," && !inAnfuehrung) {
      felder.push(feld);
      feld = "";
    } else {
      feld += c;
    }
  }
  felder.push(feld);
  return felder;
}

/** Deutsche Zahl in Cent. Leer, "-" oder Unsinn ergibt null, niemals 0. */
export function zuCents(roh: string | undefined): number | null {
  if (roh === undefined) return null;
  const s = roh.trim().replace(/\./g, "").replace(",", ".");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export interface SellerboardMonat {
  monat: string;
  umsatz_cents: number | null;
  einheiten: number | null;
  werbung_cents: number | null;
  gebuehren_cents: number | null;
  ust_cents: number | null;
  auszahlung_cents: number | null;
  wareneinsatz_cents: number | null;
}

/** Spalten, die zusammen die Amazon-Gebühren ergeben. */
const GEBUEHR_SPALTEN = [
  "Commission", "CouponParticipationFee", "DigitalServicesFee", "FBADisposalFee",
  "FBAInboundTransportationFee", "FBAInboundTransportationProgramFee",
  "FBALongTermStorageFee", "FBAPerUnitFulfillmentFee", "FBARemovalFee",
  "FBAStorageFee", "LiquidationsBrokerageFee", "Subscription",
];

const WERBE_SPALTEN = [
  "SponsoredProducts", "SponsoredDisplay", "SponsoredBrands", "SponsoredBrandsVideo",
];

/**
 * Liest Sellerboards Dashboard-CSV.
 *
 * Der Export liefert eine Zeile je Zeitraum mit DateFrom/DateTo im Format
 * TT.MM.JJJJ. Unbekannte Spalten werden ignoriert statt zu stören: Sellerboard
 * nimmt eigene Kostenarten mit auf ("DHL Kosten 19,11 pro Paket"), und die
 * ändern sich, wenn der Verkäufer sie ändert.
 */
export function leseSellerboard(csv: string): SellerboardMonat[] {
  const zeilen = csv.replace(/^﻿/, "").split(/\r?\n/).filter((z) => z.trim() !== "");
  if (zeilen.length < 2) return [];

  const kopf = csvZeile(zeilen[0]);
  const idx = (name: string) => kopf.indexOf(name);
  const summe = (f: string[], namen: string[]): number | null => {
    let s = 0;
    let gefunden = false;
    for (const n of namen) {
      const i = idx(n);
      if (i < 0) continue;
      const c = zuCents(f[i]);
      if (c !== null) { s += c; gefunden = true; }
    }
    return gefunden ? s : null;
  };

  const monate: SellerboardMonat[] = [];
  for (const zeile of zeilen.slice(1)) {
    const f = csvZeile(zeile);
    const von = f[idx("DateFrom")] ?? "";
    // TT.MM.JJJJ -> JJJJ-MM
    const m = von.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) continue;

    const organisch = zuCents(f[idx("SalesOrganic")]);
    const ppc = zuCents(f[idx("SalesPPC")]);
    const einheitenOrg = zuCents(f[idx("UnitsOrganic")]);
    const einheitenPpc = zuCents(f[idx("UnitsPPC")]);

    monate.push({
      monat: `${m[3]}-${m[2]}`,
      umsatz_cents: organisch === null && ppc === null ? null : (organisch ?? 0) + (ppc ?? 0),
      // Einheiten sind ganze Zahlen; zuCents hat sie mit 100 multipliziert.
      einheiten: einheitenOrg === null && einheitenPpc === null
        ? null
        : Math.round(((einheitenOrg ?? 0) + (einheitenPpc ?? 0)) / 100),
      werbung_cents: summe(f, WERBE_SPALTEN),
      gebuehren_cents: summe(f, GEBUEHR_SPALTEN),
      ust_cents: zuCents(f[idx("VAT")]),
      auszahlung_cents: zuCents(f[idx("EstimatedPayout")]),
      wareneinsatz_cents: zuCents(f[idx("ProductCost Sales")]),
    });
  }
  return monate;
}

// --- Vergleich --------------------------------------------------------------

export interface PulseMonat {
  monat: string;
  umsatz_cents: number | null;
  einheiten: number | null;
  werbung_cents: number | null;
  gebuehren_cents: number | null;
  ust_cents: number | null;
}

function bewerte(
  kennzahl: string, pulse: number | null, sb: number | null, label: string,
): Befund {
  if (pulse === null || sb === null || sb === 0) {
    return {
      kennzahl, pulse_cents: pulse, sellerboard_cents: sb,
      abweichung_prozent: null, bewertung: "nicht_pruefbar",
      hinweis: `${label}: eine der beiden Seiten liefert keinen Wert. Nicht `
        + "prüfbar — das ist kein Entwarnungssignal.",
    };
  }
  // Beträge vorzeichenunabhängig vergleichen: Pulse führt Gebühren negativ,
  // Sellerboard ebenso, aber das ist nicht garantiert und hier auch egal.
  const a = Math.abs(pulse);
  const b = Math.abs(sb);
  const abw = (a - b) / b;
  const betrag = Math.abs(abw);
  const bewertung: Bewertung = betrag >= ABWEICHUNG_STARK
    ? "stark"
    : (betrag >= ABWEICHUNG_WARN ? "abweichung" : "ok");

  return {
    kennzahl, pulse_cents: pulse, sellerboard_cents: sb,
    abweichung_prozent: Math.round(abw * 1000) / 10,
    bewertung,
    hinweis: bewertung === "ok" ? null
      : `${label}: Pulse ${(a / 100).toFixed(2)} €, Sellerboard `
        + `${(b / 100).toFixed(2)} € — ${(abw * 100).toFixed(1)} % Abweichung. `
        + (bewertung === "stark"
          ? "Das ist zu viel, um an Rundung oder Zeitschnitt zu liegen; bitte prüfen."
          : "Auffällig, aber im Bereich unterschiedlicher Zeitschnitte."),
  };
}

/**
 * Vergleicht einen Monat. Kennzahlen, die eine Seite nicht liefert, werden als
 * "nicht_pruefbar" gemeldet statt weggelassen — eine fehlende Prüfung ist
 * etwas anderes als eine bestandene.
 */
export function vergleiche(pulse: PulseMonat, sb: SellerboardMonat): Befund[] {
  return [
    bewerte("umsatz", pulse.umsatz_cents, sb.umsatz_cents, "Umsatz"),
    bewerte(
      "einheiten",
      pulse.einheiten === null ? null : pulse.einheiten * 100,
      sb.einheiten === null ? null : sb.einheiten * 100,
      "Einheiten",
    ),
    bewerte("werbung", pulse.werbung_cents, sb.werbung_cents, "Werbekosten"),
    bewerte("gebuehren", pulse.gebuehren_cents, sb.gebuehren_cents, "Amazon-Gebühren"),
    bewerte("umsatzsteuer", pulse.ust_cents, sb.ust_cents, "Umsatzsteuer"),
  ];
}

/** Kurzfassung für die Sync-Wache: nur was erklärungsbedürftig ist. */
export function zusammenfassung(monat: string, befunde: Befund[]): string | null {
  const auffaellig = befunde.filter((b) => b.bewertung === "stark");
  if (auffaellig.length === 0) return null;
  return `Sellerboard-Abgleich ${monat}: `
    + auffaellig.map((b) => `${b.kennzahl} ${b.abweichung_prozent} %`).join(", ")
    + ". Zwei unabhängige Rechnungen laufen auseinander — welche stimmt, muss "
    + "geprüft werden.";
}

// --- GuV-Export (manuell heruntergeladen) -----------------------------------
//
// Sellerboard kennt zwei Exportformate, und sie sind zueinander transponiert:
//
//   Automation-Link:  eine ZEILE je Zeitraum, Kennzahlen als Spalten.
//                     Liefert nur den letzten Monat — also immer den, der bei
//                     Amazon noch am wenigsten abgerechnet ist.
//   GuV-Download:     eine ZEILE je Kennzahl, Monate als Spalten.
//                     Reicht 12 Monate zurueck und enthaelt damit auch die
//                     Monate, die man wirklich pruefen kann.
//
// Der zweite ist der wertvollere, weil ein abgerechneter Monat eine echte
// Gegenprobe erlaubt. Er laesst sich nur nicht automatisch abrufen.

/** Deutsche Monatsnamen, wie sie in der Kopfzeile der GuV stehen. */
const MONATSNAMEN: Record<string, string> = {
  januar: "01", februar: "02", "märz": "03", maerz: "03", april: "04",
  mai: "05", juni: "06", juli: "07", august: "08", september: "09",
  oktober: "10", november: "11", dezember: "12",
};

/**
 * Spaltenüberschrift zu YYYY-MM.
 *
 * Gibt null zurück für alles, was kein voller Monat ist: "Gesamt" und der
 * angebrochene laufende Monat ("1.-10. September 2026"). Beide würden die
 * Prüfung verfälschen — der eine summiert ein Jahr, der andere ist unfertig.
 */
export function guvSpalteZuMonat(kopf: string): string | null {
  const t = kopf.trim();
  // "1.-10. September 2026" -> Teilmonat, nicht vergleichbar.
  if (/^\d/.test(t)) return null;
  const m = t.match(/^([A-Za-zÄÖÜäöü]+)\s+(\d{4})$/);
  if (!m) return null;
  const monat = MONATSNAMEN[m[1].toLowerCase()];
  return monat ? `${m[2]}-${monat}` : null;
}

/** Hauptposten der GuV -> unsere Kennzahlen. Unterposten sind eingerückt. */
const GUV_ZEILEN: Record<string, keyof SellerboardMonat> = {
  "Umsatz": "umsatz_cents",
  "Einheiten": "einheiten",
  "Werbekosten": "werbung_cents",
  "Amazon-Gebühren": "gebuehren_cents",
  "Umsatzsteuer": "ust_cents",
  "Einkaufspreis": "wareneinsatz_cents",
  "Erwartete Auszahlung": "auszahlung_cents",
};

/**
 * Liest den GuV-Export (Kennzahlen als Zeilen, Monate als Spalten).
 *
 * Unterposten werden übersprungen: Sellerboard rückt sie mit Leerzeichen ein
 * ("    Organisch", "    FBA-Gebühr"), und ihre Namen ändern sich mit dem
 * Sortiment. Nur die Hauptposten sind stabil genug für einen Abgleich, der
 * monatelang unbeaufsichtigt laufen soll.
 */
export function leseSellerboardGuv(csv: string): SellerboardMonat[] {
  const zeilen = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((z) => z.trim() !== "");
  if (zeilen.length < 2) return [];

  const kopf = csvZeile(zeilen[0]);
  // Spalte 0 ist die Bezeichnung; ab 1 stehen die Zeiträume.
  const spalten: Array<{ index: number; monat: string }> = [];
  for (let i = 1; i < kopf.length; i++) {
    const monat = guvSpalteZuMonat(kopf[i]);
    if (monat) spalten.push({ index: i, monat });
  }
  if (spalten.length === 0) return [];

  const je = new Map<string, SellerboardMonat>();
  for (const sp of spalten) {
    je.set(sp.monat, {
      monat: sp.monat,
      umsatz_cents: null, einheiten: null, werbung_cents: null,
      gebuehren_cents: null, ust_cents: null, auszahlung_cents: null,
      wareneinsatz_cents: null,
    });
  }

  for (const zeile of zeilen.slice(1)) {
    const f = csvZeile(zeile);
    const roh = f[0] ?? "";
    // Eingerückt = Unterposten. Der Hauptposten hat sie schon summiert.
    if (roh !== roh.trimStart()) continue;
    const feld = GUV_ZEILEN[roh.trim()];
    if (!feld) continue;

    for (const sp of spalten) {
      const eintrag = je.get(sp.monat)!;
      const wert = zuCents(f[sp.index]);
      if (wert === null) continue;
      // Einheiten sind Stückzahlen; zuCents hat mit 100 multipliziert.
      (eintrag[feld] as number | null) = feld === "einheiten"
        ? Math.round(wert / 100)
        : wert;
    }
  }

  // Monate ohne jede Zahl weglassen: eine leere Spalte ist keine Prüfung.
  return [...je.values()]
    .filter((m) => m.umsatz_cents !== null || m.einheiten !== null)
    .sort((a, b) => b.monat.localeCompare(a.monat));
}

/**
 * Erkennt das Format und liest entsprechend.
 *
 * Unterscheidungsmerkmal ist die erste Kopfzelle: der GuV-Export nennt sie
 * "Parameter/Datum", der Automation-Link beginnt mit "DateFrom".
 */
export function leseSellerboardDatei(csv: string): SellerboardMonat[] {
  const erste = csvZeile(csv.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "")[0] ?? "";
  return erste.trim().toLowerCase().startsWith("parameter")
    ? leseSellerboardGuv(csv)
    : leseSellerboard(csv);
}

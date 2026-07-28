// orders.ts — deterministische Aufbereitung der Orders-Flat-File-Zeilen.
//
// Reines Rechenmodul: keine DB, kein Netz. Analog zu metrics.ts, aber NICHT
// dessen Kopie — die Orders-Daten haben eigene Fallstricke:
//
// 1. ZEILEN SIND POSITIONEN, KEINE BESTELLUNGEN. `amazon-order-id` kann sich
//    wiederholen (eine Bestellung mit mehreren SKUs). Anzahl Bestellungen =
//    distinct order-id, NICHT rowCount.
// 2. LEERE PREISE SIND UNBEKANNT, NICHT NULL EURO. Bei sales-channel
//    "Non-Amazon" (Multi-Channel-Fulfillment) liefert Amazon KEINEN Preis.
//    Wer die leeren Felder als 0 zählt, meldet stillschweigend zu wenig Umsatz.
// 3. item-price-SEMANTIK IST UNGEKLÄRT: Stückpreis oder Zeilensumme? Am
//    Testkonto nicht entscheidbar (alle Zeilen mit Preis haben quantity=1),
//    und ein längerer Report geht wegen des 30-Tage-Limits nicht. Deshalb werden
//    BEIDE Lesarten gerechnet. Solange sie übereinstimmen (= alle bepreisten
//    Zeilen haben quantity 1), ist der Umsatz eindeutig und wird ausgegeben.
//    Sobald eine bepreiste Zeile mit quantity > 1 auftaucht, driften sie
//    auseinander — dann wird KEINE der beiden Zahlen als "der Umsatz" ausgegeben,
//    sondern eine Warnung gesetzt. Der erste solche Datensatz beantwortet die
//    Frage endgültig.
// 4. KANÄLE SIND NICHT VERGLEICHBAR mit Sales & Traffic. Hier tauchen
//    "Amazon.de", "Amazon.com.be" UND "Non-Amazon" auf; Sales & Traffic ist auf
//    EINEN Marktplatz beschränkt. Deshalb immer nach Kanal aufgeschlüsselt.
//
// Geld wird in ganzen Cent gerechnet (Fließkomma driftet beim Summieren).

export interface OrdersKennzahlen {
  bestellungen: number;
  positionen: number;
  einheiten: number;

  /** Nur gesetzt, wenn beide Lesarten übereinstimmen. Sonst null — siehe Kopf. */
  umsatz: number | null;
  umsatzAlsZeilensumme: number | null;
  umsatzAlsStueckpreisMalMenge: number | null;
  umsatzEindeutig: boolean;

  waehrung: string | null;

  /** Positionen ohne Preisangabe — deren Umsatz ist UNBEKANNT, nicht 0. */
  positionenOhnePreis: number;
  einheitenOhnePreis: number;
  umsatzVollstaendig: boolean;
}

export interface OrdersOverview {
  zeitraum: { von: string | null; bis: string | null };
  data_timestamp: string;
  is_provisional: boolean;
  gesamt: OrdersKennzahlen;
  proKanal: Array<{ kanal: string } & OrdersKennzahlen>;
  proStatus: Array<{ status: string; bestellungen: number; positionen: number; einheiten: number }>;
  proAsin: Array<{
    asin: string;
    positionen: number;
    einheiten: number;
    umsatz: number | null;
    positionenOhnePreis: number;
  }>;
  warnungen: string[];
  formeln: Record<string, string>;
}

const FORMELN: Record<string, string> = {
  bestellungen: "Anzahl verschiedener amazon-order-id — NICHT Zeilenzahl (Zeilen sind Positionen)",
  einheiten: "Σ quantity über alle Positionen",
  umsatz: "Σ item-price (in Cent), nur wenn beide Lesarten übereinstimmen; sonst null",
  umsatzAlsZeilensumme: "Σ item-price — Annahme: item-price enthält quantity bereits",
  umsatzAlsStueckpreisMalMenge: "Σ (item-price × quantity) — Annahme: item-price ist Stückpreis",
  positionenOhnePreis: "Positionen ohne item-price (v.a. sales-channel Non-Amazon) — Umsatz UNBEKANNT, nicht 0",
};

/**
 * Preisfeld → ganze Cent. Leeres Feld → null (= unbekannt), NICHT 0.
 * Der Unterschied ist der ganze Punkt: 0 behauptet "kostete nichts",
 * null sagt "wissen wir nicht".
 */
export function parsePreisCents(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Mengenfeld → Zahl. Unlesbar/leer → 0. */
export function parseMenge(s: string | undefined | null): number {
  const n = Number(String(s ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

class OrdersAkku {
  private orderIds = new Set<string>();
  positionen = 0;
  einheiten = 0;
  centsZeilensumme = 0;
  centsStueckMalMenge = 0;
  positionenOhnePreis = 0;
  einheitenOhnePreis = 0;
  /** Gibt es eine bepreiste Position mit quantity > 1? Dann driften die Lesarten. */
  mehrdeutig = false;
  waehrungen = new Set<string>();

  add(r: Record<string, string>): void {
    this.positionen++;
    const menge = parseMenge(r["quantity"]);
    this.einheiten += menge;

    const id = (r["amazon-order-id"] ?? "").trim();
    if (id) this.orderIds.add(id);

    const w = (r["currency"] ?? "").trim();
    if (w) this.waehrungen.add(w);

    const preis = parsePreisCents(r["item-price"]);
    if (preis === null) {
      // KEIN Preis heißt unbekannt — nicht 0 addieren.
      this.positionenOhnePreis++;
      this.einheitenOhnePreis += menge;
      return;
    }

    this.centsZeilensumme += preis;
    this.centsStueckMalMenge += preis * menge;
    if (menge > 1) this.mehrdeutig = true;
  }

  finish(): OrdersKennzahlen {
    const eindeutig = !this.mehrdeutig;

    // "Nichts verkauft" und "Preis unbekannt" sind NICHT dasselbe.
    // Gibt es Positionen, aber KEINE davon hat einen Preis (typisch für einen
    // reinen MCF-Kanal), dann ist die Summe nicht 0 — sie ist unbekannt.
    // 0 zu melden würde behaupten, der Kanal habe nichts umgesetzt.
    // Nur bei GAR keinen Positionen ist 0 die richtige Aussage.
    const bepreistePositionen = this.positionen - this.positionenOhnePreis;
    const alleUnbekannt = this.positionen > 0 && bepreistePositionen === 0;

    const zeilensumme = alleUnbekannt ? null : round2(this.centsZeilensumme / 100);
    const stueckMalMenge = alleUnbekannt ? null : round2(this.centsStueckMalMenge / 100);

    return {
      bestellungen: this.orderIds.size,
      positionen: this.positionen,
      einheiten: this.einheiten,
      umsatz: eindeutig ? zeilensumme : null,
      umsatzAlsZeilensumme: zeilensumme,
      umsatzAlsStueckpreisMalMenge: stueckMalMenge,
      umsatzEindeutig: eindeutig,
      waehrung: this.waehrungen.size === 1 ? [...this.waehrungen][0] : null,
      positionenOhnePreis: this.positionenOhnePreis,
      einheitenOhnePreis: this.einheitenOhnePreis,
      umsatzVollstaendig: this.positionenOhnePreis === 0,
    };
  }
}

function aggregiere(rows: Record<string, string>[]): OrdersKennzahlen {
  const a = new OrdersAkku();
  for (const r of rows) a.add(r);
  return a.finish();
}

/** Wirft, wenn mehrere Währungen vorkommen — Addieren wäre bedeutungslos. */
export function pruefeWaehrung(rows: Record<string, string>[]): void {
  const w = new Set<string>();
  for (const r of rows) {
    const c = (r["currency"] ?? "").trim();
    if (c) w.add(c);
  }
  if (w.size > 1) {
    throw new Error(`Uneinheitliche Währungen im Orders-Report: ${[...w].join(", ")}`);
  }
}

function gruppiere(
  rows: Record<string, string>[],
  schluessel: string
): Map<string, Record<string, string>[]> {
  const m = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    const k = (r[schluessel] ?? "").trim() || "(leer)";
    const liste = m.get(k);
    if (liste) liste.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function baueOrdersOverview(
  payload: Record<string, any>,
  data_timestamp: string,
  is_provisional: boolean
): OrdersOverview {
  const rows: Record<string, string>[] = payload?.rows ?? [];
  pruefeWaehrung(rows);

  const gesamt = aggregiere(rows);

  // Nach Kanal: Pflicht, nicht Kür. "Non-Amazon" (MCF) und andere Marktplätze
  // liegen im selben Report wie Amazon.de — undifferenziert summiert ist die
  // Zahl mit nichts vergleichbar.
  const proKanal = [...gruppiere(rows, "sales-channel")]
    .map(([kanal, rs]) => ({ kanal, ...aggregiere(rs) }))
    .sort((a, b) => b.positionen - a.positionen);

  const proStatus = [...gruppiere(rows, "order-status")]
    .map(([status, rs]) => {
      const k = aggregiere(rs);
      return { status, bestellungen: k.bestellungen, positionen: k.positionen, einheiten: k.einheiten };
    })
    .sort((a, b) => b.positionen - a.positionen);

  const proAsin = [...gruppiere(rows, "asin")]
    .map(([asin, rs]) => {
      const k = aggregiere(rs);
      return {
        asin,
        positionen: k.positionen,
        einheiten: k.einheiten,
        umsatz: k.umsatz,
        positionenOhnePreis: k.positionenOhnePreis,
      };
    })
    .sort((a, b) => (b.umsatz ?? 0) - (a.umsatz ?? 0) || b.einheiten - a.einheiten);

  const daten = rows.map((r) => (r["purchase-date"] ?? "").trim()).filter(Boolean).sort();

  return {
    zeitraum: { von: daten[0] ?? null, bis: daten[daten.length - 1] ?? null },
    data_timestamp,
    is_provisional,
    gesamt,
    proKanal,
    proStatus,
    proAsin,
    warnungen: baueWarnungen(gesamt, proKanal, proStatus),
    formeln: FORMELN,
  };
}

function baueWarnungen(
  gesamt: OrdersKennzahlen,
  proKanal: Array<{ kanal: string } & OrdersKennzahlen>,
  proStatus: Array<{ status: string; positionen: number }>
): string[] {
  const w: string[] = [];

  if (!gesamt.umsatzEindeutig) {
    w.push(
      "item-price-Semantik ist jetzt entscheidbar: es gibt Positionen mit Preis UND quantity > 1. " +
        `Die beiden Lesarten unterschieden sich (${gesamt.umsatzAlsZeilensumme} vs. ` +
        `${gesamt.umsatzAlsStueckpreisMalMenge}). Deshalb wird kein Umsatz ausgegeben (umsatz: null). ` +
        "Bitte einmal in Seller Central gegenprüfen, welche Lesart stimmt, und danach in orders.ts festschreiben."
    );
  }

  if (!gesamt.umsatzVollstaendig) {
    const kanaele = proKanal.filter((k) => k.positionenOhnePreis > 0).map((k) => k.kanal);
    w.push(
      `${gesamt.positionenOhnePreis} von ${gesamt.positionen} Positionen haben KEINEN Preis ` +
        `(${gesamt.einheitenOhnePreis} Einheiten, Kanäle: ${kanaele.join(", ")}). ` +
        "Deren Umsatz ist unbekannt, nicht 0 — der ausgewiesene Umsatz ist entsprechend unvollständig."
    );
  }

  const pending = proStatus.find((s) => s.status.toLowerCase() === "pending");
  if (pending) {
    w.push(
      `${pending.positionen} Position(en) stehen auf "Pending" — Status und Preise können sich noch ändern.`
    );
  }

  if (proKanal.length > 1) {
    w.push(
      `Mehrere Vertriebskanäle (${proKanal.map((k) => k.kanal).join(", ")}). ` +
        "Nicht mit get-sales-overview vergleichen: Sales & Traffic deckt nur EINEN Marktplatz ab."
    );
  }

  return w;
}

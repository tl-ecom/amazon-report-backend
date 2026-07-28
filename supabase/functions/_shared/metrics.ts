// metrics.ts — deterministische Aufbereitung der Sales-&-Traffic-Daten.
//
// Reines Rechenmodul: keine DB, kein Netz, keine Seiteneffekte. Damit ist es
// unit-testbar (siehe metrics_test.ts) und später auch vom MCP-Server nutzbar.
//
// GRUNDREGEL (Operator-Ansatz): Kennzahlen werden aus den ROHWERTEN gerechnet,
// niemals aus Amazons fertigen Prozentspalten.
//   RICHTIG: CVR = Σ unitsOrdered / Σ sessions
//   FALSCH : Σ unitSessionPercentage  oder  Ø unitSessionPercentage
// Warum: Prozentwerte sind nicht additiv und ihr ungewichteter Mittelwert
// überbewertet Tage mit wenig Traffic. Beispiel: Tag A 10/100 (10 %),
// Tag B 1/1 (100 %). Richtig sind 11/101 = 10,89 %. Die Summe ergäbe 110 %,
// der Mittelwert 55 % — beides grob falsch. Genau das prüft der Test.
//
// GELD: Beträge werden in ganzen Cent summiert. Summiert man Fließkommazahlen
// direkt, driftet das Ergebnis (0.1 + 0.2 = 0.30000000000000004).

export interface Money {
  amount: number;
  currencyCode: string;
}

/** Rohsummen + daraus abgeleitete Kennzahlen. */
export interface Kennzahlen {
  // Rohsummen (einfach addierbar)
  sessions: number;
  pageViews: number;
  unitsOrdered: number;
  totalOrderItems: number;
  unitsShipped: number;
  ordersShipped: number;
  unitsRefunded: number;
  umsatzOrdered: number;
  umsatzShipped: number;
  waehrung: string | null;

  // Abgeleitet — null, wenn der Nenner 0 ist (kein 0, kein NaN, kein Infinity:
  // "keine Aussage möglich" ist etwas anderes als "null Prozent").
  cvrUnitSession: number | null;
  cvrOrderItemSession: number | null;
  durchschnittspreis: number | null;
  retourenquote: number | null;
  pageViewsProSession: number | null;
}

export interface AsinKennzahlen extends Kennzahlen {
  childAsin: string;
  parentAsin: string;
  umsatzAnteil: number | null;
}

export interface Konsistenz {
  ok: boolean;
  abweichungen: string[];
}

export interface Overview {
  zeitraum: { von: string | null; bis: string | null; tage: number };
  data_timestamp: string;
  is_provisional: boolean;
  gesamt: Kennzahlen;
  proAsin: AsinKennzahlen[];
  konsistenz: Konsistenz;
  formeln: Record<string, string>;
}

const FORMELN: Record<string, string> = {
  umsatzOrdered: "Σ orderedProductSales.amount (in Cent summiert, dann /100)",
  cvrUnitSession: "Σ unitsOrdered / Σ sessions × 100 — NICHT Σ/Ø unitSessionPercentage",
  cvrOrderItemSession: "Σ totalOrderItems / Σ sessions × 100",
  durchschnittspreis: "Σ orderedProductSales / Σ unitsOrdered — NICHT Ø averageSellingPrice",
  retourenquote: "Σ unitsRefunded / Σ unitsShipped × 100",
  pageViewsProSession: "Σ pageViews / Σ sessions",
  umsatzAnteil: "Umsatz dieser ASIN / Gesamtumsatz über alle ASINs × 100",
};

/** Division, die bei Nenner 0 ehrlich null liefert statt 0/NaN/Infinity. */
export function safeDiv(zaehler: number, nenner: number): number | null {
  if (!nenner) return null;
  const r = zaehler / nenner;
  return Number.isFinite(r) ? r : null;
}

export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function roundOrNull(x: number | null): number | null {
  return x === null ? null : round2(x);
}

/** Geldbetrag → ganze Cent. Verhindert Fließkomma-Drift beim Summieren. */
export function toCents(m: Money | undefined | null): number {
  if (!m || typeof m.amount !== "number") return 0;
  return Math.round(m.amount * 100);
}

class Akku {
  sessions = 0;
  pageViews = 0;
  unitsOrdered = 0;
  totalOrderItems = 0;
  unitsShipped = 0;
  ordersShipped = 0;
  unitsRefunded = 0;
  centsOrdered = 0;
  centsShipped = 0;
  waehrungen = new Set<string>();

  addSales(s: Record<string, any>): void {
    this.unitsOrdered += num(s.unitsOrdered);
    this.totalOrderItems += num(s.totalOrderItems);
    this.unitsShipped += num(s.unitsShipped);
    this.ordersShipped += num(s.ordersShipped);
    this.unitsRefunded += num(s.unitsRefunded);
    this.centsOrdered += toCents(s.orderedProductSales);
    this.centsShipped += toCents(s.shippedProductSales);
    for (const f of ["orderedProductSales", "shippedProductSales"]) {
      const c = s[f]?.currencyCode;
      if (c) this.waehrungen.add(c);
    }
  }

  addTraffic(t: Record<string, any>): void {
    // Bewusst NUR Rohwerte. Die Prozentspalten (unitSessionPercentage,
    // sessionPercentage, buyBoxPercentage, ...) werden nie aufsummiert.
    this.sessions += num(t.sessions);
    this.pageViews += num(t.pageViews);
  }

  finish(): Kennzahlen {
    const umsatzOrdered = this.centsOrdered / 100;
    return {
      sessions: this.sessions,
      pageViews: this.pageViews,
      unitsOrdered: this.unitsOrdered,
      totalOrderItems: this.totalOrderItems,
      unitsShipped: this.unitsShipped,
      ordersShipped: this.ordersShipped,
      unitsRefunded: this.unitsRefunded,
      umsatzOrdered: round2(umsatzOrdered),
      umsatzShipped: round2(this.centsShipped / 100),
      waehrung: this.waehrungen.size === 1 ? [...this.waehrungen][0] : null,
      cvrUnitSession: roundOrNull(mul100(safeDiv(this.unitsOrdered, this.sessions))),
      cvrOrderItemSession: roundOrNull(mul100(safeDiv(this.totalOrderItems, this.sessions))),
      durchschnittspreis: roundOrNull(safeDiv(umsatzOrdered, this.unitsOrdered)),
      retourenquote: roundOrNull(mul100(safeDiv(this.unitsRefunded, this.unitsShipped))),
      pageViewsProSession: roundOrNull(safeDiv(this.pageViews, this.sessions)),
    };
  }
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function mul100(x: number | null): number | null {
  return x === null ? null : x * 100;
}

/** Prüft, dass im gesamten Payload nur EINE Währung vorkommt. */
export function pruefeWaehrung(payload: Record<string, any>): string {
  const gefunden = new Set<string>();
  for (const d of payload.salesAndTrafficByDate ?? []) {
    for (const f of ["orderedProductSales", "shippedProductSales"]) {
      const c = d.salesByDate?.[f]?.currencyCode;
      if (c) gefunden.add(c);
    }
  }
  for (const a of payload.salesAndTrafficByAsin ?? []) {
    for (const f of ["orderedProductSales", "shippedProductSales"]) {
      const c = a.salesByAsin?.[f]?.currencyCode;
      if (c) gefunden.add(c);
    }
  }
  if (gefunden.size > 1) {
    // Beträge verschiedener Währungen zu addieren ergibt eine Zahl ohne Bedeutung.
    throw new Error(`Uneinheitliche Währungen im Report: ${[...gefunden].join(", ")}`);
  }
  return [...gefunden][0] ?? "";
}

export function aggregiereNachDatum(payload: Record<string, any>): Kennzahlen {
  const akku = new Akku();
  for (const d of payload.salesAndTrafficByDate ?? []) {
    akku.addSales(d.salesByDate ?? {});
    akku.addTraffic(d.trafficByDate ?? {});
  }
  return akku.finish();
}

export function aggregiereNachAsin(payload: Record<string, any>): Kennzahlen {
  const akku = new Akku();
  for (const a of payload.salesAndTrafficByAsin ?? []) {
    akku.addSales(a.salesByAsin ?? {});
    akku.addTraffic(a.trafficByAsin ?? {});
  }
  return akku.finish();
}

export function proAsin(payload: Record<string, any>): AsinKennzahlen[] {
  const eintraege = payload.salesAndTrafficByAsin ?? [];
  const gesamtCents = eintraege.reduce(
    (s: number, a: any) => s + toCents(a.salesByAsin?.orderedProductSales),
    0
  );

  const liste: AsinKennzahlen[] = eintraege.map((a: any) => {
    const akku = new Akku();
    akku.addSales(a.salesByAsin ?? {});
    akku.addTraffic(a.trafficByAsin ?? {});
    const k = akku.finish();
    return {
      childAsin: a.childAsin ?? "",
      parentAsin: a.parentAsin ?? "",
      ...k,
      umsatzAnteil: roundOrNull(
        mul100(safeDiv(toCents(a.salesByAsin?.orderedProductSales), gesamtCents))
      ),
    };
  });

  // Umsatzstärkste zuerst; bei Gleichstand die mit mehr Traffic.
  liste.sort((x, y) => y.umsatzOrdered - x.umsatzOrdered || y.sessions - x.sessions);
  return liste;
}

/**
 * Vergleicht beide Granularitäten desselben Reports.
 * Sie MÜSSEN bei stabilem Fenster übereinstimmen. Tun sie es nicht, ist das
 * Fenster volatil (letzte ~2 Tage: Bestellungen ohne Traffic) oder etwas stimmt
 * nicht — in beiden Fällen soll es sichtbar sein statt stillschweigend gemittelt.
 */
export function pruefeKonsistenz(nachDatum: Kennzahlen, nachAsin: Kennzahlen): Konsistenz {
  const abweichungen: string[] = [];
  const vgl: Array<[string, number, number]> = [
    ["sessions", nachDatum.sessions, nachAsin.sessions],
    ["pageViews", nachDatum.pageViews, nachAsin.pageViews],
    ["unitsOrdered", nachDatum.unitsOrdered, nachAsin.unitsOrdered],
    ["umsatzOrdered", nachDatum.umsatzOrdered, nachAsin.umsatzOrdered],
  ];
  for (const [name, a, b] of vgl) {
    if (Math.abs(a - b) > 0.009) {
      abweichungen.push(`${name}: byDate=${a} vs. byAsin=${b}`);
    }
  }
  return { ok: abweichungen.length === 0, abweichungen };
}

/**
 * Baut die vollständige Auswertung.
 * Basis für die Gesamtzahlen ist byDate (die Tagesreihe), weil sie bei stabilem
 * Fenster mit byAsin übereinstimmt und zusätzlich den Zeitbezug trägt.
 */
export function baueOverview(
  payload: Record<string, any>,
  data_timestamp: string,
  is_provisional: boolean
): Overview {
  pruefeWaehrung(payload);

  const nachDatum = aggregiereNachDatum(payload);
  const nachAsin = aggregiereNachAsin(payload);
  const tage = payload.salesAndTrafficByDate ?? [];

  return {
    zeitraum: {
      von: tage[0]?.date ?? null,
      bis: tage[tage.length - 1]?.date ?? null,
      tage: tage.length,
    },
    data_timestamp,
    is_provisional,
    gesamt: nachDatum,
    proAsin: proAsin(payload),
    konsistenz: pruefeKonsistenz(nachDatum, nachAsin),
    formeln: FORMELN,
  };
}

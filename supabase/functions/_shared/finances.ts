// finances.ts — reiner Parser für die SP-API Finances API (listFinancialEvents).
// Summiert alle FeeAmount (signiert; negativ = Kosten) je PostedDate-Monat.
// FBA-Fulfillment, Referral/Verkaufsgebühr, Retouren-Gebühren, Service-Fees stehen
// als { FeeAmount: { CurrencyAmount, CurrencyCode } } tief in den Event-Listen.
//
// Grenze (ehrlich): Events OHNE PostedDate (z. B. manche Service-Fees) lassen sich
// keinem Monat zuordnen und werden übersprungen — kann Gebühren leicht unterschätzen.

export function monatAusDatum(iso: unknown): string | null {
  if (typeof iso !== "string" || iso.length < 7) return null;
  return iso.slice(0, 7);
}

/** Sammelt rekursiv alle FeeAmount.CurrencyAmount-Beträge unter einem Knoten. */
function sammleFeeBetraege(node: any, out: number[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) sammleFeeBetraege(x, out);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "FeeAmount" && v && typeof v === "object" && typeof (v as any).CurrencyAmount === "number") {
      out.push((v as any).CurrencyAmount);
    } else {
      sammleFeeBetraege(v, out);
    }
  }
}

/** Verarbeitet die FinancialEvents einer API-Seite in den Monats-Akku (in Währungseinheiten, signiert). */
export function verarbeiteFinancialEvents(events: any, akku: Map<string, number>): void {
  if (!events || typeof events !== "object") return;
  for (const liste of Object.values(events)) {
    if (!Array.isArray(liste)) continue;
    for (const ev of liste as any[]) {
      const monat = monatAusDatum(ev?.PostedDate);
      if (!monat) continue; // ohne PostedDate nicht zuordenbar
      const betraege: number[] = [];
      sammleFeeBetraege(ev, betraege);
      const summe = betraege.reduce((s, x) => s + x, 0);
      if (summe !== 0) akku.set(monat, (akku.get(monat) ?? 0) + summe);
    }
  }
}

/** Akku (Währungseinheiten) -> Zeilen mit signierten Cents, gerundet. */
export function akkuZuZeilen(akku: Map<string, number>): Array<{ monat: string; gebuehren_cents: number }> {
  return [...akku.entries()]
    .map(([monat, betrag]) => ({ monat, gebuehren_cents: Math.round(betrag * 100) }))
    .sort((a, b) => a.monat.localeCompare(b.monat));
}

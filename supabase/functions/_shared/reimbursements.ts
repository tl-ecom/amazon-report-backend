// reimbursements.ts — Reimbursements-Radar (DataDoe #1), Schritt 2: der ABGLEICH.
// REINE Funktion, kein DB-Zugriff (wie strategie.ts / diagnostics.ts): Input sind
// Adjustments + Reimbursements, Output sind Anspruchs-KANDIDATEN.
//
// Ehrlichkeit (Kernprinzip): Das ist eine KANDIDATENLISTE, keine Garantie. Amazon
// entscheidet über jeden Fall; der Seller reicht den Antrag in Seller Central ein.
// Wir behaupten keinen Anspruch — wir zeigen, WO ein Verlust ohne Erstattung steht.
//
// Logik je ASIN über den Zeitraum:
//   verloren   = Summe der entfernten Einheiten (negative Adjustments)
//   gefunden   = Summe der wieder eingebuchten (positive Adjustments)
//   netto_verlust = max(0, verloren − gefunden)   // gefundene Einheiten heben Verluste auf
//   erstattet_einheiten = Summe erstatteter Einheiten (aus Reimbursements)
//   offen_einheiten = max(0, netto_verlust − erstattet_einheiten)
//   Wert = offen × Satz je Einheit (Ø aus echten Erstattungen dieser ASIN;
//          Fallback Verkaufspreis, falls die ASIN nie erstattet wurde).

export interface Adjustment {
  asin: string | null;
  datum?: string | null;
  quantity: number; // signiert: negativ = entfernt/verloren
  reason?: string | null;
}
export interface Reimbursement {
  asin: string | null;
  quantity_total?: number | null;
  quantity_inventory?: number | null;
  quantity_cash?: number | null;
  amount_total_cents?: number | null;
  approval_date?: string | null;
}

export interface Kandidat {
  asin: string;
  verloren: number;
  gefunden: number;
  netto_verlust: number;
  erstattet_einheiten: number;
  offen_einheiten: number;
  satz_cents: number | null;      // Ø Wert je Einheit
  satz_quelle: "erstattung" | "preis" | null;
  geschaetzt_cents: number | null; // offen × Satz
  letzter_verlust: string | null;
}
export interface RadarErgebnis {
  kandidaten: Kandidat[];             // offen_einheiten > 0, wertvollste zuerst
  summe_offen_einheiten: number;
  summe_geschaetzt_cents: number;     // Summe über Kandidaten MIT bekanntem Satz
  kandidaten_ohne_wert: number;       // offene Einheiten, aber kein Satz/Preis bekannt
  erstattet_gesamt_cents: number;     // was Amazon insgesamt schon erstattet hat
  anzahl_verlust_events: number;
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function asinOf(x: string | null | undefined): string {
  return String(x ?? "").trim();
}

/**
 * Findet Anspruchs-Kandidaten. `preisProAsin` (ASIN → Cent) ist optional und dient
 * NUR als Wert-Fallback, wenn eine verlustbehaftete ASIN noch nie erstattet wurde.
 */
export function findeAnspruchskandidaten(
  adjustments: Adjustment[],
  reimbursements: Reimbursement[],
  preisProAsin: Record<string, number> = {},
): RadarErgebnis {
  // 1) Adjustments je ASIN aggregieren.
  const adj = new Map<string, { verloren: number; gefunden: number; letzter: string | null; events: number }>();
  let verlustEvents = 0;
  for (const a of adjustments) {
    const asin = asinOf(a.asin);
    if (!asin) continue;
    const q = nz(a.quantity);
    const e = adj.get(asin) ?? { verloren: 0, gefunden: 0, letzter: null, events: 0 };
    if (q < 0) {
      e.verloren += -q;
      e.events += 1;
      verlustEvents += 1;
      const d = a.datum ?? null;
      if (d && (!e.letzter || d > e.letzter)) e.letzter = d;
    } else if (q > 0) {
      e.gefunden += q;
    }
    adj.set(asin, e);
  }

  // 2) Erstattungen je ASIN + gesamt.
  const erst = new Map<string, { einheiten: number; cents: number }>();
  let erstattetGesamt = 0;
  for (const r of reimbursements) {
    const einh = r.quantity_total != null
      ? nz(r.quantity_total)
      : nz(r.quantity_inventory) + nz(r.quantity_cash);
    const cents = nz(r.amount_total_cents);
    erstattetGesamt += cents;
    const asin = asinOf(r.asin);
    if (!asin) continue;
    const e = erst.get(asin) ?? { einheiten: 0, cents: 0 };
    e.einheiten += einh;
    e.cents += cents;
    erst.set(asin, e);
  }

  // 3) Offene Einheiten + Wert je ASIN.
  const kandidaten: Kandidat[] = [];
  let summeOffen = 0, summeGesch = 0, ohneWert = 0;
  for (const [asin, e] of adj) {
    const netto = Math.max(0, e.verloren - e.gefunden);
    const er = erst.get(asin) ?? { einheiten: 0, cents: 0 };
    const offen = Math.max(0, netto - er.einheiten);
    if (offen <= 0) continue;

    let satz: number | null = null;
    let quelle: Kandidat["satz_quelle"] = null;
    if (er.einheiten > 0) {
      satz = Math.round(er.cents / er.einheiten);
      quelle = "erstattung";
    } else if (preisProAsin[asin] > 0) {
      satz = Math.round(preisProAsin[asin]);
      quelle = "preis";
    }
    const gesch = satz != null ? satz * offen : null;

    summeOffen += offen;
    if (gesch != null) summeGesch += gesch;
    else ohneWert += offen;

    kandidaten.push({
      asin,
      verloren: e.verloren,
      gefunden: e.gefunden,
      netto_verlust: netto,
      erstattet_einheiten: er.einheiten,
      offen_einheiten: offen,
      satz_cents: satz,
      satz_quelle: quelle,
      geschaetzt_cents: gesch,
      letzter_verlust: e.letzter,
    });
  }
  kandidaten.sort((a, b) =>
    (b.geschaetzt_cents ?? -1) - (a.geschaetzt_cents ?? -1) || b.offen_einheiten - a.offen_einheiten
  );

  return {
    kandidaten,
    summe_offen_einheiten: summeOffen,
    summe_geschaetzt_cents: summeGesch,
    kandidaten_ohne_wert: ohneWert,
    erstattet_gesamt_cents: erstattetGesamt,
    anzahl_verlust_events: verlustEvents,
  };
}

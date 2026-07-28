// returns.ts — Aufbereitung des Merchant-Retouren-Reports (nach Antragsdatum).
//
// Reines Modul: keine DB, kein Netz.
//
// EHRLICHE EINSCHRÄNKUNG (wichtig): Dieses Modul wurde gebaut, als der echte
// Report LEER war (0 Retouren im Testzeitraum). Die 35 Spaltennamen sind bekannt
// und selbsterklärend, aber die genauen WERT-Formate sind nicht an echten Daten
// verifiziert. Deshalb:
//   * String-Gruppierungen (Return Reason, Resolution, Status, ASIN) sind
//     formatsicher — sie zählen nur, egal wie der Wert aussieht.
//   * Return quantity / Order quantity: als Ganzzahl tolerant geparst.
//   * Geldfelder (Refunded Amount): tolerant geparst; unlesbar → null (nicht 0).
//   * Datumsfelder: als String durchgereicht, KEIN Parsing (Format unbekannt).
// Der Output trägt `unvalidiert: true` und einen Hinweis, bis der erste echte
// Retouren-Datensatz die Formate bestätigt.
//
// Die RETOURENQUOTE (Retouren / verkaufte Einheiten) steht hier bewusst NICHT:
// der Nenner kommt aus Orders/Sales — das ist ein späterer Cross-Report-Schritt
// (analog product.ts), kein Wert aus diesem einen Report.

export interface ReturnsOverview {
  data_timestamp: string;
  unvalidiert: boolean;
  zeitraum: { von: string | null; bis: string | null };
  gesamt: {
    retouren: number; // Zeilen
    einheiten: number; // Σ Return quantity
    erstattet_bekannt: number | null; // Σ Refunded Amount, null wenn nichts lesbar
    waehrung: string | null;
    zeilen_ohne_betrag: number;
  };
  nach_grund: Array<{ grund: string; retouren: number; einheiten: number }>;
  nach_resolution: Array<{ resolution: string; retouren: number }>;
  nach_status: Array<{ status: string; retouren: number }>;
  nach_asin: Array<{ asin: string; sku: string; name: string; retouren: number; einheiten: number }>;
  warnungen: string[];
  formeln: Record<string, string>;
}

// Spaltennamen exakt wie in der echten Kopfzeile (mit Leerzeichen, Groß/klein).
const SP = {
  reason: "Return Reason",
  resolution: "Resolution",
  status: "Return request status",
  asin: "ASIN",
  sku: "Merchant SKU",
  name: "Item Name",
  qty: "Return quantity",
  refunded: "Refunded Amount",
  currency: "Currency code",
  requestDate: "Return request date",
} as const;

function parseMenge(s: string | undefined): number {
  const n = Number(String(s ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Geldbetrag → ganze Cent. Leer/unlesbar → null (unbekannt, nicht 0). */
function parseBetragCents(s: string | undefined): number | null {
  if (s === undefined) return null;
  let t = String(s).trim();
  if (t === "") return null;
  // Tolerant: evtl. Währungssymbol/Leerzeichen entfernen, Komma als Dezimaltrenner.
  t = t.replace(/[^\d.,-]/g, "");
  if (t.includes(",") && !t.includes(".")) t = t.replace(",", ".");
  else t = t.replace(/,/g, ""); // Tausendertrenner
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function zaehleNach<T extends string>(
  rows: Record<string, string>[],
  key: string,
  leerLabel = "(ohne Angabe)"
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = ((r[key] ?? "").trim() || leerLabel) as T;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function baueReturnsOverview(
  payload: Record<string, any>,
  data_timestamp: string
): ReturnsOverview {
  const rows: Record<string, string>[] = payload?.rows ?? [];

  let einheiten = 0;
  let cents = 0;
  let ohneBetrag = 0;
  const waehrungen = new Set<string>();

  for (const r of rows) {
    einheiten += parseMenge(r[SP.qty]);
    const b = parseBetragCents(r[SP.refunded]);
    if (b === null) ohneBetrag++;
    else cents += b;
    const w = (r[SP.currency] ?? "").trim();
    if (w) waehrungen.add(w);
  }

  // Gruppierung nach Grund (mit Einheiten).
  const grundEinheiten = new Map<string, { retouren: number; einheiten: number }>();
  for (const r of rows) {
    const g = (r[SP.reason] ?? "").trim() || "(ohne Angabe)";
    const e = grundEinheiten.get(g) ?? { retouren: 0, einheiten: 0 };
    e.retouren++;
    e.einheiten += parseMenge(r[SP.qty]);
    grundEinheiten.set(g, e);
  }

  // Gruppierung nach ASIN.
  const asinMap = new Map<string, { sku: string; name: string; retouren: number; einheiten: number }>();
  for (const r of rows) {
    const a = (r[SP.asin] ?? "").trim() || "(ohne ASIN)";
    const e = asinMap.get(a) ?? { sku: (r[SP.sku] ?? "").trim(), name: (r[SP.name] ?? "").trim().slice(0, 80), retouren: 0, einheiten: 0 };
    e.retouren++;
    e.einheiten += parseMenge(r[SP.qty]);
    asinMap.set(a, e);
  }

  const daten = rows.map((r) => (r[SP.requestDate] ?? "").trim()).filter(Boolean).sort();

  const warnungen: string[] = [];
  if (rows.length === 0) {
    warnungen.push("Keine Retouren im Zeitraum.");
  }
  warnungen.push(
    "Aufbereitung basiert auf der Spaltenstruktur, ist aber an echten Retouren-Daten " +
      "noch nicht validiert (Report war bei Erstellung leer). String-Gruppierungen " +
      "(Grund/Resolution/Status/ASIN) sind sicher; Geldbeträge beim ersten echten " +
      "Datensatz gegenprüfen."
  );
  if (waehrungen.size > 1) {
    warnungen.push(`Mehrere Währungen (${[...waehrungen].join(", ")}) — Summe erstattet ist dann bedeutungslos.`);
  }

  return {
    data_timestamp,
    unvalidiert: true,
    zeitraum: { von: daten[0] ?? null, bis: daten[daten.length - 1] ?? null },
    gesamt: {
      retouren: rows.length,
      einheiten,
      erstattet_bekannt: rows.length === 0 || ohneBetrag === rows.length ? null : Math.round(cents) / 100,
      waehrung: waehrungen.size === 1 ? [...waehrungen][0] : null,
      zeilen_ohne_betrag: ohneBetrag,
    },
    nach_grund: [...grundEinheiten].map(([grund, e]) => ({ grund, ...e })).sort((a, b) => b.retouren - a.retouren),
    nach_resolution: [...zaehleNach(rows, SP.resolution)].map(([resolution, retouren]) => ({ resolution, retouren })).sort((a, b) => b.retouren - a.retouren),
    nach_status: [...zaehleNach(rows, SP.status)].map(([status, retouren]) => ({ status, retouren })).sort((a, b) => b.retouren - a.retouren),
    nach_asin: [...asinMap].map(([asin, e]) => ({ asin, ...e })).sort((a, b) => b.einheiten - a.einheiten),
    warnungen,
    formeln: {
      einheiten: "Σ 'Return quantity'",
      erstattet_bekannt: "Σ 'Refunded Amount' (tolerant geparst); null wenn keine Zeile einen lesbaren Betrag hat",
      retourenquote: "NICHT hier — Nenner (verkaufte Einheiten) kommt aus Orders/Sales (Cross-Report, später)",
    },
  };
}

// betriebskosten.ts — Kosten, die NICHT am einzelnen Verkauf hängen.
//
// Anlieferung ins Amazon-Lager, Lagerung, Langzeitlagerung, Entfernung und die
// Gutschriften für verlorene Ware. Quelle sind die Abrechnungsberichte
// (settlement_zeilen), nicht finance_gebuehren — die Finances-Auswertung greift
// nur FeeAmount-Knoten ab, diese Buchungen kommen anders strukturiert.
//
// BEWUSST GETRENNT von den Verkaufsgebühren: Anlieferung fällt je Lieferung an,
// nicht je Verkauf. Eine Umlage auf Produkte wäre geraten, und in der
// Gebührenspalte des Break-even hätte sie nichts zu suchen.
//
// NETTO IST DIE ENTSCHEIDENDE ZAHL. Die Umsatzsteuer auf diese Gebühren kommt
// als Vorsteuer zurück und ist damit kein Kosten. Brutto steht daneben, weil es
// der Betrag ist, der tatsächlich vom Guthaben abging.
//
// Zwei Formate, je nach Alter der Abrechnung:
//   neu: getrennte Zeilen 'Base fee' (netto) und 'Tax on fee'  -> exakt
//   alt: EINE Zeile mit dem Bruttobetrag, ohne Steuerausweis    -> gerechnet
// Wo gerechnet wurde, sagt das Ergebnis es (steuer_gerechnet). Eine abgeleitete
// Zahl als abgelesene auszugeben wäre die Art von Unschärfe, die später niemand
// mehr erkennt.

import { nettoGebuehr } from "./ust_faktor.ts";
import { ladeUstFaktor } from "./ust_lauf.ts";
import { zeitraumAus } from "./ads_verlauf.ts";

export interface BetriebskostenRow {
  kategorie: string;
  netto_ausgewiesen_cents: number | string;
  steuer_ausgewiesen_cents: number | string;
  brutto_ohne_ausweis_cents: number | string;
  zeilen: number | string;
}

export interface BetriebskostenPosten {
  kategorie: string;
  bezeichnung: string;
  netto: number;
  brutto: number;
  steuer: number;
  /** true = die Steuer wurde aus dem Bruttobetrag gerechnet, nicht ausgewiesen. */
  steuer_gerechnet: boolean;
  buchungen: number;
}

const BEZEICHNUNG: Record<string, string> = {
  anlieferung: "Anlieferung ins Lager",
  lagerung: "Lagergebühren",
  langzeitlagerung: "Langzeit-Lagergebühren",
  entfernung: "Entfernung und Entsorgung",
  erstattungen: "Erstattungen für verlorene Ware",
};

// Reihenfolge der Anzeige: erst was Geld kostet, zuletzt was zurückkommt.
const REIHENFOLGE = ["anlieferung", "lagerung", "langzeitlagerung", "entfernung", "erstattungen"];

/**
 * Gutschriften sind keine Gebühr. Sie durch den Steuerfaktor zu teilen, um ein
 * „Netto" zu erhalten, wäre eine Behauptung über ihre steuerliche Behandlung,
 * die die Abrechnung nicht hergibt — sie stehen deshalb wie gebucht.
 */
const KEINE_VORSTEUER = new Set(["erstattungen"]);

function n(x: unknown): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function baueBetriebskosten(
  rows: BetriebskostenRow[],
  ustFaktor: number | null,
): { posten: BetriebskostenPosten[]; summe_netto: number; summe_brutto: number; hinweise: string[] } {
  const posten: BetriebskostenPosten[] = [];

  for (const r of rows) {
    const nettoAus = n(r.netto_ausgewiesen_cents);
    const steuerAus = n(r.steuer_ausgewiesen_cents);
    const ohneAusweis = n(r.brutto_ohne_ausweis_cents);
    const ohneVorsteuer = KEINE_VORSTEUER.has(r.kategorie);

    // Bruttobetraege ohne Steuerausweis: netto nur rechenbar, nicht ablesbar.
    const abgeleitetNetto = ohneVorsteuer ? ohneAusweis : nettoGebuehr(ohneAusweis, ustFaktor);

    const nettoCents = nettoAus + abgeleitetNetto;
    const bruttoCents = nettoAus + steuerAus + ohneAusweis;

    posten.push({
      kategorie: r.kategorie,
      bezeichnung: BEZEICHNUNG[r.kategorie] ?? r.kategorie,
      netto: r2(nettoCents / 100),
      brutto: r2(bruttoCents / 100),
      steuer: r2((bruttoCents - nettoCents) / 100),
      steuer_gerechnet: !ohneVorsteuer && ohneAusweis !== 0,
      buchungen: n(r.zeilen),
    });
  }

  posten.sort((a, b) => {
    const ia = REIHENFOLGE.indexOf(a.kategorie);
    const ib = REIHENFOLGE.indexOf(b.kategorie);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const hinweise: string[] = [];
  if (posten.some((p) => p.steuer_gerechnet)) {
    hinweise.push(
      "Ältere Abrechnungen weisen die Umsatzsteuer nicht getrennt aus — für diese Posten " +
        "ist der Nettobetrag gerechnet, nicht abgelesen.",
    );
  }
  if (posten.length === 0) {
    hinweise.push("Keine Betriebskosten im Zeitraum gebucht.");
  }

  return {
    posten,
    summe_netto: r2(posten.reduce((s, p) => s + p.netto, 0)),
    summe_brutto: r2(posten.reduce((s, p) => s + p.brutto, 0)),
    hinweise,
  };
}

/** Einziger Teil dieses Moduls, der die DB anfasst. Zeitraum wie überall sonst. */
export async function betriebskosten(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);

  const [summen, ustFaktor] = await Promise.all([
    supabase.rpc("betriebskosten_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    ladeUstFaktor(supabase, tenant_id),
  ]);
  if (summen?.error) throw new Error(`betriebskosten_summen: ${summen.error.message}`);

  return {
    zeitraum: { von, bis },
    ...baueBetriebskosten((summen?.data ?? []) as BetriebskostenRow[], ustFaktor),
    rechenweg:
      "Netto ist der Kosten — die Umsatzsteuer kommt als Vorsteuer zurück. Brutto ist der Betrag, " +
      "der vom Guthaben abging. Getrennt von den Verkaufsgebühren: diese Kosten fallen je Lieferung " +
      "bzw. je Zeitraum an, nicht je Verkauf.",
  };
}

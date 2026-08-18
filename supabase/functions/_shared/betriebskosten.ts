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
import { type Abdeckung, abgedeckterZeitraum, findeLuecken } from "./abdeckung.ts";

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

export interface Werbeabgleich {
  ads_api: number | null;
  abrechnung_netto: number | null;
  abrechnung_brutto: number | null;
  differenz: number | null;
  abweichung_prozent: number | null;
  belastbar: boolean;
  hinweis: string;
}

/**
 * Gegenprobe: Werbekosten aus zwei unabhängigen Quellen.
 *
 * Die Ads-API meldet, was an einem Anzeigentag ausgegeben wurde. Die Abrechnung
 * meldet, was Amazon wann vom Guthaben abgezogen hat. ZWEI ZEITACHSEN — kleine
 * Abweichungen sind deshalb normal und kein Fehler.
 *
 * Aussagekräftig ist der Vergleich nur ohne Abrechnungslücken. Und auch dann
 * nur eingeschränkt: Werbung wird nicht zwingend über das Guthaben abgerechnet,
 * sie kann auch per Karte belastet werden. Ein Fehlbetrag auf der
 * Abrechnungsseite ist also nicht automatisch ein Datenfehler. Deshalb steht
 * hier `belastbar` statt einer Ampel — die Zahlen laden zum Nachsehen ein, sie
 * urteilen nicht.
 */
export function baueWerbeabgleich(
  adsSpendCents: number | null,
  werbungRow: BetriebskostenRow | null,
  ustFaktor: number | null,
  ohneLuecken: boolean,
): Werbeabgleich {
  const adsApi = adsSpendCents === null ? null : r2(adsSpendCents / 100);

  let abrNetto: number | null = null;
  let abrBrutto: number | null = null;
  if (werbungRow) {
    const nettoAus = n(werbungRow.netto_ausgewiesen_cents);
    const steuerAus = n(werbungRow.steuer_ausgewiesen_cents);
    const ohneAusweis = n(werbungRow.brutto_ohne_ausweis_cents);
    // Beträge kommen negativ (Abzug) — für den Vergleich als Ausgabe positiv.
    abrNetto = r2(-(nettoAus + nettoGebuehr(ohneAusweis, ustFaktor)) / 100);
    abrBrutto = r2(-(nettoAus + steuerAus + ohneAusweis) / 100);
  }

  const vergleichbar = adsApi !== null && abrNetto !== null && adsApi > 0;
  const differenz = vergleichbar ? r2(adsApi - abrNetto!) : null;
  const abweichung = vergleichbar ? r2((differenz! / adsApi!) * 100) : null;

  let hinweis: string;
  if (!vergleichbar) {
    hinweis = "Zum Vergleich fehlt eine der beiden Quellen im Zeitraum.";
  } else if (!ohneLuecken) {
    hinweis = "Im Zeitraum fehlen Abrechnungen — die Abweichung ist deshalb nicht aussagekräftig.";
  } else {
    hinweis =
      "Die Ads-API bucht nach Anzeigentag, die Abrechnung nach Buchungstag — kleine Abweichungen " +
      "sind normal. Werbung kann zudem per Karte statt über das Guthaben belastet werden; dann " +
      "fehlt sie auf der Abrechnungsseite, ohne dass ein Fehler vorliegt.";
  }

  return {
    ads_api: adsApi,
    abrechnung_netto: abrNetto,
    abrechnung_brutto: abrBrutto,
    differenz,
    abweichung_prozent: abweichung,
    belastbar: vergleichbar && ohneLuecken,
    hinweis,
  };
}

/** Einziger Teil dieses Moduls, der die DB anfasst. Zeitraum wie überall sonst. */
export async function betriebskosten(
  supabase: any,
  tenant_id: string,
  opts?: { tage?: unknown; von?: unknown; bis?: unknown },
): Promise<unknown> {
  const { von, bis } = zeitraumAus(opts);

  const [summen, ustFaktor, abdeckung, adsSummen] = await Promise.all([
    supabase.rpc("betriebskosten_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    ladeUstFaktor(supabase, tenant_id),
    supabase.rpc("settlement_abdeckung", { p_tenant: tenant_id }),
    supabase.rpc("ads_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
  ]);
  if (summen?.error) throw new Error(`betriebskosten_summen: ${summen.error.message}`);

  const alleRows = (summen?.data ?? []) as BetriebskostenRow[];
  // Werbung ist KEIN Kostenposten dieser Ansicht — sie steht schon im Ads-Bereich.
  // Sie dient hier nur als Gegenprobe zur Ads-API.
  const basis = baueBetriebskosten(alleRows.filter((r) => r.kategorie !== "werbung"), ustFaktor);

  // Lücken in den Abrechnungen: Alles hier Gerechnete ist nur so vollständig wie
  // die vorliegenden Abrechnungen. Fehlt ein Zeitraum, sind die Summen zu
  // niedrig — und sähen ohne diesen Hinweis aus wie fertige Zahlen.
  const bereiche = (abdeckung?.data ?? []) as Abdeckung[];
  const luecken = findeLuecken(bereiche).filter((l) => l.bis >= von && l.von <= bis);

  const adsGesamt = ((adsSummen?.data ?? []) as Array<{ ebene: string; spend_cents: number | string }>)
    .find((r) => r.ebene === "gesamt");

  return {
    zeitraum: { von, bis },
    ...basis,
    hinweise: [
      ...basis.hinweise,
      ...luecken.map((l) =>
        `Abrechnungslücke ${l.von} bis ${l.bis} (${l.tage} Tage) — Kosten aus diesem Zeitraum ` +
        "fehlen, die Summen sind insoweit zu niedrig."
      ),
    ],
    abdeckung: {
      zeitraum: abgedeckterZeitraum(bereiche),
      abrechnungen: bereiche.length,
      luecken,
    },
    werbeabgleich: baueWerbeabgleich(
      adsGesamt ? Number(adsGesamt.spend_cents) : null,
      alleRows.find((r) => r.kategorie === "werbung") ?? null,
      ustFaktor,
      luecken.length === 0,
    ),
    rechenweg:
      "Netto ist der Kosten — die Umsatzsteuer kommt als Vorsteuer zurück. Brutto ist der Betrag, " +
      "der vom Guthaben abging. Getrennt von den Verkaufsgebühren: diese Kosten fallen je Lieferung " +
      "bzw. je Zeitraum an, nicht je Verkauf.",
  };
}

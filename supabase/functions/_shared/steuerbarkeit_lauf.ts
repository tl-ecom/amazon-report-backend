// steuerbarkeit_lauf.ts — DB-Schicht für Modul 1 (steuerbar vs. nicht steuerbar).
// Die Regeln liegen rein und getestet in steuerbarkeit.ts.
//
// Zwei Quellen mit UNTERSCHIEDLICHER Steuerbasis — das ist der Fallstrick:
//
//   * Abrechnung (settlement_zeilen): gebuchte Beträge, enthalten die
//     Umsatzsteuer. Sie müssen durch den USt.-Faktor.
//   * Lagerbericht (fba_lagergebuehren): Rate-Card-Werte, bereits NETTO.
//     Sie noch einmal zu teilen würde die Steuer zweimal herausrechnen.
//
// Deshalb wird der Faktor nur auf die Abrechnungspositionen angewandt und die
// Lagerpositionen fliessen unverändert ein.

import { analysiereSteuerbarkeit, type Klassifizierung, type Position } from "./steuerbarkeit.ts";
import { ladeUstFaktor } from "./ust_lauf.ts";

export async function steuerbarkeitReport(
  supabase: any, tenant_id: string, opts?: { von?: unknown; bis?: unknown },
): Promise<unknown> {
  const bis = istDatum(opts?.bis) ? String(opts?.bis) : new Date().toISOString().slice(0, 10);
  const von = istDatum(opts?.von)
    ? String(opts?.von)
    : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

  const [abrechnung, lager, klass, ustFaktor] = await Promise.all([
    supabase.from("settlement_zeilen")
      .select("betrag_beschreibung, betrag_cents, gebucht_am")
      .eq("tenant_id", tenant_id).eq("betrag_typ", "ItemFees")
      .gte("gebucht_am", von).lte("gebucht_am", bis),
    supabase.from("fba_lagergebuehren")
      .select("monat, basis_cents, zuschlag_cents, gesamt_cents")
      .eq("tenant_id", tenant_id)
      .gte("monat", von.slice(0, 7)).lte("monat", bis.slice(0, 7)),
    supabase.from("fee_type_classification").select("*"),
    ladeUstFaktor(supabase, tenant_id),
  ]);
  if (abrechnung.error) throw new Error(`settlement_zeilen: ${abrechnung.error.message}`);
  if (lager.error) throw new Error(`fba_lagergebuehren: ${lager.error.message}`);

  const faktor = ustFaktor ?? 1;

  // Abrechnung: brutto gebucht -> Faktor anwenden.
  const positionen: Position[] = ((abrechnung.data ?? []) as any[])
    .filter((r) => r.betrag_beschreibung && Number.isFinite(Number(r.betrag_cents)))
    .map((r) => ({
      fee_typ: String(r.betrag_beschreibung),
      betrag_cents: Number(r.betrag_cents),
      quelle: "abrechnung" as const,
    }));

  // Lager: bereits netto -> ust_enthalten:false, damit der Faktor sie in Ruhe laesst.
  const alsKosten = (cents: number) => -Math.round(cents);
  for (const r of (lager.data ?? []) as any[]) {
    const gesamt = Number(r.gesamt_cents) || 0;
    const zuschlag = Number(r.zuschlag_cents) || 0;
    // Basis = Gesamt − Zuschlag. Amazon liefert est_base_msf nicht in jeder
    // Zeile; die Gesamtsumme steht dagegen immer.
    const basis = gesamt - zuschlag;
    if (basis !== 0) {
      positionen.push({
        fee_typ: "FBALagergebuehrBasis", betrag_cents: alsKosten(basis),
        quelle: "lager", ust_enthalten: false,
      });
    }
    if (zuschlag !== 0) {
      positionen.push({
        fee_typ: "FBALagernutzungszuschlag", betrag_cents: alsKosten(zuschlag),
        quelle: "lager", ust_enthalten: false,
      });
    }
  }

  const klassifizierung: Klassifizierung[] = ((klass.data ?? []) as any[]).map((k) => ({
    fee_typ: String(k.fee_typ),
    label: k.label ?? null,
    steuerbar: k.steuerbar === null || k.steuerbar === undefined ? null : Boolean(k.steuerbar),
    hebel: k.hebel ?? null,
    hebel_alternativ: k.hebel_alternativ ?? null,
    massnahme: k.massnahme ?? null,
  }));

  const ergebnis = analysiereSteuerbarkeit(positionen, klassifizierung, faktor);

  return {
    von, bis,
    quellen: {
      abrechnung_positionen: positionen.filter((p) => p.quelle === "abrechnung").length,
      lager_positionen: positionen.filter((p) => p.quelle === "lager").length,
    },
    ust_faktor: faktor,
    ...ergebnis,
    ...(positionen.length === 0
      ? {
        nicht_bewertbar_grund:
          "Für diesen Zeitraum liegen weder Abrechnungs- noch Lagergebühren vor. " +
          "Der Abrechnungsbericht wird je Auszahlung geholt, der Lagerbericht monatlich.",
      }
      : {}),
  };
}

function istDatum(s: unknown): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

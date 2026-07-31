// produkte.ts — Per-Produkt-Übersicht (Umsatz/Einheiten/Retouren je ASIN, +
// Rohertrag/Rohmarge sobald EK je ASIN hinterlegt ist). Nettogewinn/ACOS folgen
// mit Gebühren (SP-API Finances) bzw. Ads — hier bewusst NICHT gefaked.
//
// Umsatzsteuer in den Gebühren: Amazon bucht Gebühren als EINEN Betrag, ohne die
// Steuer auszuweisen (nachgewiesen im Abrechnungsbericht). Für einen
// vorsteuerabzugsberechtigten Verkäufer ist die enthaltene USt. aber ein
// durchlaufender Posten und KEIN Kosten. Deshalb wird mit dem bestätigten
// Faktor auf netto gerechnet — und ohne Bestätigung gar nicht.

import { nettoGebuehr } from "./ust_faktor.ts";
import { ladeUstFaktor } from "./ust_lauf.ts";

function runde(n: number, stellen = 2): number {
  const f = 10 ** stellen;
  return Math.round(n * f) / f;
}

interface Row {
  asin: string; produktname: string; umsatz_cents: number; einheiten: number;
  wareneinsatz_cents: number; einheiten_mit_ek: number; retouren: number;
  gebuehren_cents: number; gebuehren_bekannt: boolean; gebuehren_anteilig: boolean;
}

function istDatum(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function produktUebersicht(
  supabase: any, tenant_id: string, opts?: { tage?: unknown; von?: unknown; bis?: unknown },
): Promise<unknown> {
  let von: string, bis: string;
  if (istDatum(opts?.von) && istDatum(opts?.bis)) {
    // Frei gewählter Zeitraum (Kalender).
    von = opts!.von as string;
    bis = opts!.bis as string;
    if (von > bis) [von, bis] = [bis, von];
  } else {
    // Preset: letzte N Tage.
    const fenster = Number(opts?.tage) > 0 ? Number(opts?.tage) : 90;
    von = new Date(Date.now() - fenster * 86400000).toISOString().slice(0, 10);
    bis = new Date().toISOString().slice(0, 10);
  }
  const [{ data, error }, ustFaktor] = await Promise.all([
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    ladeUstFaktor(supabase, tenant_id),
  ]);
  if (error) throw new Error(`produkt_uebersicht: ${error.message}`);

  const produkte = ((data ?? []) as Row[]).map((r) => {
    const umsatz = (Number(r.umsatz_cents) || 0) / 100;
    const wareneinsatz = (Number(r.wareneinsatz_cents) || 0) / 100;
    const einheiten = Number(r.einheiten) || 0;
    const hatEk = (Number(r.einheiten_mit_ek) || 0) > 0;
    const rohertrag = hatEk ? runde(umsatz - wareneinsatz) : null;
    const retouren = Number(r.retouren) || 0;

    // Amazon-Gebühren je Produkt (signiert, negativ = Kosten).
    // Ohne bestätigten Faktor lässt nettoGebuehr den Betrag unverändert.
    const hatGeb = Boolean(r.gebuehren_bekannt);
    const gebuehren = hatGeb ? nettoGebuehr(Number(r.gebuehren_cents) || 0, ustFaktor) / 100 : null;
    // Nettogewinn = Umsatz − Wareneinsatz + Gebühren(negativ). Nur mit BEIDEM.
    const nettogewinn = hatEk && hatGeb && rohertrag != null ? runde(rohertrag + gebuehren!) : null;
    // Zwischenstufe ohne EK: was nach Amazon übrig bleibt.
    const umsatzNachGebuehren = hatGeb ? runde(umsatz + gebuehren!) : null;

    return {
      asin: r.asin,
      produktname: r.produktname,
      umsatz: runde(umsatz),
      einheiten,
      retouren,
      rohertrag,
      rohmarge: hatEk && umsatz > 0 && rohertrag != null ? runde((rohertrag / umsatz) * 100, 1) : null,
      retourenquote: einheiten > 0 ? runde((retouren / einheiten) * 100, 1) : null,
      gebuehren: gebuehren == null ? null : runde(gebuehren),
      gebuehrenquote: hatGeb && umsatz > 0 ? runde((-gebuehren! / umsatz) * 100, 1) : null,
      gebuehren_anteilig: Boolean(r.gebuehren_anteilig),
      umsatz_nach_gebuehren: umsatzNachGebuehren,
      nettogewinn,
      nettomarge: nettogewinn != null && umsatz > 0 ? runde((nettogewinn / umsatz) * 100, 1) : null,
    };
  });

  const mitGebuehren = produkte.filter((p) => p.gebuehren != null);
  return {
    von, bis,
    waehrung: "EUR",
    produkte,
    summe_retouren: produkte.reduce((s, p) => s + p.retouren, 0),
    // Gebühren-Überblick: was ist bekannt, wie verlässlich ist die Zuordnung?
    hat_gebuehren: mitGebuehren.length > 0,
    summe_gebuehren: mitGebuehren.length ? runde(mitGebuehren.reduce((s, p) => s + (p.gebuehren ?? 0), 0)) : null,
    gebuehren_anteilig: produkte.some((p) => p.gebuehren_anteilig),
    produkte_ohne_gebuehren: produkte.filter((p) => p.umsatz > 0 && p.gebuehren == null).length,
    // Damit die Anzeige sagen kann, WORAUF die Marge steht.
    gebuehren_ust_faktor: ustFaktor,
    gebuehren_basis: ustFaktor === null ? "wie_gebucht" : (ustFaktor <= 1.005 ? "netto_ohne_ust" : "netto"),
  };
}

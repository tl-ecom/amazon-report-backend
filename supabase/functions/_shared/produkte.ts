// produkte.ts — Per-Produkt-Übersicht je ASIN.
//
// Die Rechnung:
//   Nettoumsatz  = Umsatz − Umsatzsteuer
//   Rohertrag    = Nettoumsatz − Einkaufspreis
//   Nettogewinn  = Rohertrag − Amazon-Gebühren (netto) − Werbekosten
//
// Zwei Steuerbeträge, die nichts miteinander zu tun haben und beide raus müssen:
//
//   1. Umsatzsteuer auf den UMSATZ. Der Verkäufer vereinnahmt sie und führt sie
//      ab — sie war nie sein Geld. 9.356 € brutto sind bei 19 % nur 7.862 €.
//   2. Vorsteuer in den GEBÜHREN. Amazon bucht sie ohne Ausweis mit; bei
//      Vorsteuerabzug kommt sie zurück und ist kein Kosten.
//
// Beides folgt aus dem Steuerprofil der Firma. Die Marge auf den Bruttoumsatz zu
// rechnen, während die Gebühren netto stehen, macht jede Zahl systematisch zu
// schön — genau in der Größenordnung des Steuersatzes.
//
// Werbekosten sind noch nicht angebunden (Ads-API bei Amazon nicht freigegeben).
// Sie werden deshalb als UNBEKANNT ausgewiesen, nicht als 0 — sonst stünde da
// ein Gewinn, den es so nicht gibt.

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
  const [{ data, error }, ustFaktor, einstellung] = await Promise.all([
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    ladeUstFaktor(supabase, tenant_id),
    supabase.from("tenant_einstellungen").select("umsatzsteuer_prozent")
      .eq("tenant_id", tenant_id).maybeSingle(),
  ]);
  if (error) throw new Error(`produkt_uebersicht: ${error.message}`);

  // Umsatzsteuersatz auf den eigenen Umsatz. 19 % ist der Regelfall in
  // Deutschland; 0 bei Kleinunternehmern, deren Umsatz bereits netto ist.
  const ustSatz = Number(einstellung?.data?.umsatzsteuer_prozent ?? 19);
  const umsatzTeiler = Number.isFinite(ustSatz) && ustSatz >= 0 && ustSatz < 100
    ? 1 + ustSatz / 100
    : 1;

  const produkte = ((data ?? []) as Row[]).map((r) => {
    const umsatzBrutto = (Number(r.umsatz_cents) || 0) / 100;
    // Alles Weitere rechnet auf dem NETTOUMSATZ. Die vereinnahmte Umsatzsteuer
    // gehört dem Finanzamt; sie in Marge oder Gewinn zu führen wäre erfunden.
    const umsatz = runde(umsatzBrutto / umsatzTeiler);
    const umsatzsteuer = runde(umsatzBrutto - umsatz);
    const wareneinsatz = (Number(r.wareneinsatz_cents) || 0) / 100;
    const einheiten = Number(r.einheiten) || 0;
    const hatEk = (Number(r.einheiten_mit_ek) || 0) > 0;
    const rohertrag = hatEk ? runde(umsatz - wareneinsatz) : null;
    const retouren = Number(r.retouren) || 0;

    // Amazon-Gebühren je Produkt (signiert, negativ = Kosten).
    // Ohne bestätigten Faktor lässt nettoGebuehr den Betrag unverändert.
    const hatGeb = Boolean(r.gebuehren_bekannt);
    const gebuehren = hatGeb ? nettoGebuehr(Number(r.gebuehren_cents) || 0, ustFaktor) / 100 : null;

    // Nettogewinn OHNE Werbekosten — die fehlen noch. Der Name sagt das, damit
    // niemand ihn für das Endergebnis hält.
    const vorWerbung = hatEk && hatGeb && rohertrag != null ? runde(rohertrag + gebuehren!) : null;
    // Zwischenstufe ohne EK: was nach Amazon übrig bleibt.
    const umsatzNachGebuehren = hatGeb ? runde(umsatz + gebuehren!) : null;

    return {
      asin: r.asin,
      produktname: r.produktname,
      umsatz,                 // netto — die Basis aller Quoten
      umsatz_brutto: runde(umsatzBrutto),
      umsatzsteuer,
      // Wareneinsatz sichtbar machen: ohne ihn ist der Rohertrag eine Behauptung.
      // null statt 0, solange kein EK hinterlegt ist — 0 hiesse "kostenlos".
      wareneinsatz: hatEk ? runde(wareneinsatz) : null,
      einheiten,
      retouren,
      rohertrag,
      rohmarge: hatEk && umsatz > 0 && rohertrag != null ? runde((rohertrag / umsatz) * 100, 1) : null,
      retourenquote: einheiten > 0 ? runde((retouren / einheiten) * 100, 1) : null,
      gebuehren: gebuehren == null ? null : runde(gebuehren),
      gebuehrenquote: hatGeb && umsatz > 0 ? runde((-gebuehren! / umsatz) * 100, 1) : null,
      gebuehren_anteilig: Boolean(r.gebuehren_anteilig),
      umsatz_nach_gebuehren: umsatzNachGebuehren,
      // Werbekosten fehlen -> das Endergebnis ist NICHT berechenbar.
      werbekosten: null,
      nettogewinn_vor_werbung: vorWerbung,
      marge_vor_werbung: vorWerbung != null && umsatz > 0 ? runde((vorWerbung / umsatz) * 100, 1) : null,
      nettogewinn: null,
      nettomarge: null,
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
    umsatzsteuer_prozent: ustSatz,
    summe_umsatz_netto: runde(produkte.reduce((s, p) => s + p.umsatz, 0)),
    summe_umsatzsteuer: runde(produkte.reduce((s, p) => s + p.umsatzsteuer, 0)),
    // Werbekosten fehlen -> der Nettogewinn ist unvollstaendig, und das steht hier.
    hat_werbekosten: false,
    rechenweg: "Nettoumsatz = Umsatz − Umsatzsteuer. Rohertrag = Nettoumsatz − Einkaufspreis. " +
      "Nettogewinn = Rohertrag − Amazon-Gebühren (netto) − Werbekosten.",
    fehlt: ["Werbekosten (PPC) — die Ads-API ist für dieses Konto noch nicht freigegeben"],
  };
}

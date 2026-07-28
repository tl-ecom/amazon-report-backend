// produkte.ts — Per-Produkt-Übersicht (Umsatz/Einheiten/Retouren je ASIN, +
// Rohertrag/Rohmarge sobald EK je ASIN hinterlegt ist). Nettogewinn/ACOS folgen
// mit Gebühren (SP-API Finances) bzw. Ads — hier bewusst NICHT gefaked.

function runde(n: number, stellen = 2): number {
  const f = 10 ** stellen;
  return Math.round(n * f) / f;
}

interface Row {
  asin: string; produktname: string; umsatz_cents: number; einheiten: number;
  wareneinsatz_cents: number; einheiten_mit_ek: number; retouren: number;
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
  const { data, error } = await supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: von, p_bis: bis });
  if (error) throw new Error(`produkt_uebersicht: ${error.message}`);

  const produkte = ((data ?? []) as Row[]).map((r) => {
    const umsatz = (Number(r.umsatz_cents) || 0) / 100;
    const wareneinsatz = (Number(r.wareneinsatz_cents) || 0) / 100;
    const einheiten = Number(r.einheiten) || 0;
    const hatEk = (Number(r.einheiten_mit_ek) || 0) > 0;
    const rohertrag = hatEk ? runde(umsatz - wareneinsatz) : null;
    const retouren = Number(r.retouren) || 0;
    return {
      asin: r.asin,
      produktname: r.produktname,
      umsatz: runde(umsatz),
      einheiten,
      retouren,
      rohertrag,
      rohmarge: hatEk && umsatz > 0 && rohertrag != null ? runde((rohertrag / umsatz) * 100, 1) : null,
      retourenquote: einheiten > 0 ? runde((retouren / einheiten) * 100, 1) : null,
    };
  });

  return {
    von, bis,
    waehrung: "EUR",
    produkte,
    summe_retouren: produkte.reduce((s, p) => s + p.retouren, 0),
  };
}

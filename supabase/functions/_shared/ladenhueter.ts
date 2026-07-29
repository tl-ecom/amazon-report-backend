// ladenhueter.ts — Ladenhüter-/Dead-Stock-Radar (DataDoe #5).
//
// Gegenstück zum Nachschub-Radar (#4): Während #4 sagt „lief gut, plötzlich weg
// -> nachbestellen", sagt #5 „Nachfrage ist versiegt -> nicht nachbestellen,
// prüfen ob liquidieren/auslisten". Zwei Klassen:
//   tot        — seit >= 60 Tagen kein Verkauf, hatte aber Historie.
//   abkühlend  — verkaufte im Vorquartal ordentlich, jetzt <= 30 % davon.
//
// EHRLICH: Ohne Live-Bestand können wir kein „gebundenes Kapital" in Einheiten
// messen. Wir zeigen daher Nachfrage-Signale (Velocity-Verfall) + den realen
// Monatsumsatz-Einbruch, wo Preisdaten vorliegen. Kein erfundener Bestandswert.

export const MIN_LIFETIME = 20;   // < 20 je ASIN verkauft: nie richtig gelaufen, kein „Ladenhüter"
export const TOT_TAGE = 60;       // >= 60 Tage kein Verkauf -> tot
export const ALT_MIN_VELO = 0.2;  // Vorquartal-Velocity (Stk/Tag), ab der „abkühlend" überhaupt zählt
export const KUEHL_FAKTOR = 0.3;  // jetzt <= 30 % der alten Velocity -> abkühlend

export type LhStatus = "tot" | "abkuehlend" | "ok";

export interface LhInput {
  lifetime_units: number;
  units_0_30: number;
  umsatz_0_30_cents: number;
  units_30_120: number;
  umsatz_30_120_cents: number;
  tage_ohne_verkauf: number;
}
export interface LhBewertung {
  status: LhStatus;
  schwere: number;                // 2 tot, 1 abkühlend, 0 ok
  einbruch_cents: number;         // Monatsumsatz Vorquartal − jetzt (>= 0), soweit Preisdaten da sind
  umsatz_alt_monat_cents: number; // Ø Monatsumsatz im Vorquartal (30–120 Tage)
  velo_alt: number;               // Stk/Tag Vorquartal
  velo_neu: number;               // Stk/Tag letzte 30 Tage
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Reine Einstufung EINER ASIN. */
export function bewerteLadenhueter(i: LhInput): LhBewertung {
  const lifetime = nz(i.lifetime_units);
  const veloAlt = nz(i.units_30_120) / 90;
  const veloNeu = nz(i.units_0_30) / 30;
  const umsatzAltMonat = Math.round(nz(i.umsatz_30_120_cents) / 3); // 90 Tage -> 30 Tage
  const einbruch = Math.max(0, umsatzAltMonat - nz(i.umsatz_0_30_cents));
  const basis = { einbruch_cents: einbruch, umsatz_alt_monat_cents: umsatzAltMonat, velo_alt: veloAlt, velo_neu: veloNeu };

  if (lifetime < MIN_LIFETIME) return { status: "ok", schwere: 0, ...basis };
  if (nz(i.tage_ohne_verkauf) >= TOT_TAGE) return { status: "tot", schwere: 2, ...basis };
  if (veloAlt >= ALT_MIN_VELO && veloNeu <= KUEHL_FAKTOR * veloAlt) {
    return { status: "abkuehlend", schwere: 1, ...basis };
  }
  return { status: "ok", schwere: 0, ...basis };
}

/** DB-Wrapper: RPC-Basis + Produktnamen zusammenführen, einstufen, Auffällige zurück. */
export async function ladenhueterRadar(supabase: any, tenant_id: string): Promise<unknown> {
  const [basisRes, asinRes] = await Promise.all([
    supabase.rpc("ladenhueter_basis", { p_tenant: tenant_id }),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
  ]);
  const basis = (basisRes.data ?? []) as any[];
  const titel = new Map<string, string>(
    ((asinRes.data ?? []) as any[]).map((a) => [String(a.asin), String(a.produktname ?? a.asin)]),
  );

  const zeilen = basis.map((r) => {
    const b = bewerteLadenhueter({
      lifetime_units: nz(r.lifetime_units),
      units_0_30: nz(r.units_0_30),
      umsatz_0_30_cents: nz(r.umsatz_0_30_cents),
      units_30_120: nz(r.units_30_120),
      umsatz_30_120_cents: nz(r.umsatz_30_120_cents),
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
    });
    return {
      asin: String(r.asin),
      produktname: titel.get(String(r.asin)) ?? String(r.asin),
      lifetime_units: nz(r.lifetime_units),
      units_0_30: nz(r.units_0_30),
      units_30_120: nz(r.units_30_120),
      letzter_verkauf: r.letzter_verkauf ?? null,
      tage_ohne_verkauf: nz(r.tage_ohne_verkauf),
      status: b.status,
      schwere: b.schwere,
      einbruch_cents: b.einbruch_cents,
      umsatz_alt_monat_cents: b.umsatz_alt_monat_cents,
    };
  }).filter((z) => z.status !== "ok");

  zeilen.sort((a, b) =>
    (b.schwere - a.schwere) || (b.einbruch_cents - a.einbruch_cents) || (b.lifetime_units - a.lifetime_units)
  );

  const zaehle = (s: LhStatus) => zeilen.filter((z) => z.status === s).length;
  return {
    waehrung: "EUR",
    zeilen,
    // Nur der Umsatz-Einbruch der abkühlenden Produkte (verlässliche, jüngste Preisdaten).
    summe_einbruch_cents: zeilen.filter((z) => z.status === "abkuehlend").reduce((s, z) => s + z.einbruch_cents, 0),
    anzahl_tot: zaehle("tot"),
    anzahl_abkuehlend: zaehle("abkuehlend"),
    anzahl_asins_geprueft: basis.length,
  };
}

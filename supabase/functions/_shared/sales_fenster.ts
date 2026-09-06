// sales_fenster.ts — Sales & Traffic über einen FREI WÄHLBAREN Zeitraum.
//
// Der reguläre Stand (get_sales_overview) ist das zuletzt gezogene 30-Tage-
// Fenster des Schedulers. Hier wählt der Nutzer 60, 90 Tage oder einen
// Kalenderzeitraum; dafür wird EIN Sales-&-Traffic-Report bei Amazon
// angefordert (bis 90 Tage erlaubt) und als Fenster-Report abgelegt. Beim
// zweiten Aufruf desselben Fensters ist er sofort da.
//
// Drei Zustände, die der Aufrufer unterscheiden muss:
//   fertig  → der Report liegt vor, die Kennzahlen stehen in der Antwort
//   laeuft  → angefordert, Amazon erstellt ihn noch (1–3 Minuten sind normal)
//   fehlt   → noch nie angefordert — mit der Aktion sales_fenster_laden anstoßen
//
// Die Kennzahlen kommen aus baueOverview — dieselbe Formel wie beim Stand.

import { baueOverview } from "./metrics.ts";

const REPORT_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";
/** Amazons Traffic-Daten hinken ~2 Tage nach (siehe sync-report). */
export const STABILER_LAG_TAGE = 2;
/** Amazon erlaubt für Sales & Traffic höchstens 90 Tage je Anfrage. */
export const MAX_FENSTER_TAGE = 90;
/** Nach so vielen Stunden gilt ein laufender Job als aufgegeben. */
const LAUF_MAX_STUNDEN = 6;

export interface Fenster {
  von: string;
  bis: string;
  schluessel: string;
}

function istDatum(x: unknown): x is string {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x + "T00:00:00Z"));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fenster aus den Argumenten: von/bis (Kalender) oder tage (Preset). Das Ende
 * wird auf heute minus STABILER_LAG_TAGE gekappt, damit das Fenster keine
 * Bestellungen ohne zugehörige Sessions enthält; der Anfang auf höchstens
 * MAX_FENSTER_TAGE davor. Der Schlüssel identifiziert den abgelegten Report.
 */
export function normalisiereFenster(
  opts: { von?: unknown; bis?: unknown; tage?: unknown } | undefined,
  heute: Date = new Date(),
): Fenster {
  const spaetestens = ymd(new Date(heute.getTime() - STABILER_LAG_TAGE * 86_400_000));
  let von: string;
  let bis: string;
  if (istDatum(opts?.von) && istDatum(opts?.bis)) {
    von = opts!.von as string;
    bis = opts!.bis as string;
    if (von > bis) [von, bis] = [bis, von];
  } else {
    const tage = Number(opts?.tage) > 0 ? Math.min(Number(opts?.tage), MAX_FENSTER_TAGE) : 30;
    bis = spaetestens;
    von = ymd(new Date(Date.parse(bis + "T00:00:00Z") - (tage - 1) * 86_400_000));
  }
  if (bis > spaetestens) bis = spaetestens;
  const fruehestens = ymd(new Date(Date.parse(bis + "T00:00:00Z") - (MAX_FENSTER_TAGE - 1) * 86_400_000));
  if (von < fruehestens) von = fruehestens;
  if (von > bis) von = bis;
  return { von, bis, schluessel: `${von}_${bis}` };
}

/** Stand eines Fensters lesen. Fordert NICHTS an. */
export async function salesFenster(
  supabase: any,
  tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; tage?: unknown },
): Promise<unknown> {
  const f = normalisiereFenster(opts);

  const { data: row, error } = await supabase
    .from("report_data")
    .select("payload, data_timestamp, is_provisional, created_at")
    .eq("tenant_id", tenant_id).eq("source", "sp").eq("report_type", REPORT_TYPE)
    .eq("fenster->>schluessel", f.schluessel)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`report_data: ${error.message}`);

  if (row) {
    const overview = baueOverview(row.payload, row.data_timestamp, row.is_provisional) as unknown as Record<string, unknown>;
    return { status: "fertig", fenster: f, geholt_am: row.created_at, ...overview };
  }

  const seit = new Date(Date.now() - LAUF_MAX_STUNDEN * 3_600_000).toISOString();
  const { data: job } = await supabase
    .from("report_jobs")
    .select("status, created_at, error_detail")
    .eq("tenant_id", tenant_id).eq("source", "sp").eq("report_type", REPORT_TYPE)
    .eq("config->fenster->>schluessel", f.schluessel)
    .gte("created_at", seit)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (job?.status === "PROCESSING") {
    return { status: "laeuft", fenster: f, seit: job.created_at, hinweis: "Amazon erstellt den Bericht — 1 bis 3 Minuten sind normal." };
  }
  if (job?.status === "FATAL") {
    return { status: "fehlgeschlagen", fenster: f, detail: job.error_detail ?? "ohne Meldung" };
  }
  return { status: "fehlt", fenster: f };
}

/**
 * Fenster-Report anfordern — aber nur, wenn er weder vorliegt noch läuft.
 * Jeder Abruf ist eine Anfrage bei Amazon; die spart man sich, wo es geht.
 */
export async function salesFensterLaden(
  supabase: any,
  tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; tage?: unknown },
): Promise<unknown> {
  const stand = await salesFenster(supabase, tenant_id, opts) as { status: string; fenster: Fenster };
  if (stand.status === "fertig" || stand.status === "laeuft") return stand;

  const { error } = await supabase.rpc("sales_fenster_anstossen", {
    p_tenant: tenant_id, p_von: stand.fenster.von, p_bis: stand.fenster.bis,
  });
  if (error) throw new Error(`sales_fenster_anstossen: ${error.message}`);
  return { status: "laeuft", fenster: stand.fenster, seit: new Date().toISOString(), hinweis: "Bericht bei Amazon angefordert — 1 bis 3 Minuten sind normal." };
}

// Welchen Marktplatz liest ein Ads-Leser?
//
// Ein Werbe-Profil gilt je Marktplatz. Seit dem 14.09.2026 ist `marktplatz` in
// allen Ads-Tabellen Teil des Primaerschluessels, und die SQL-Leser nehmen
// `p_marktplatz`. Die TypeScript-Leser gaben ihn bisher nicht weiter — solange
// nur Deutschland in den Tabellen stand, fiel das nicht auf. Mit einem zweiten
// Profil wuerden sie deutsche und franzoesische Zahlen in einer Summe mischen:
// die gefaehrlichste Art von Fehler, weil das Ergebnis plausibel aussieht.
//
// Ohne Angabe gilt der Marktplatz der SP-Verbindung. Bestehende Ansichten
// bleiben damit Zeichen fuer Zeichen gleich.

const FALLBACK = "A1PA6795UKMFR9"; // Amazon.de

export interface MarktplatzOpts {
  marktplatz?: unknown;
}

/** Marktplatz aus den Argumenten, sonst der Haupt-Marktplatz des Mandanten. */
export async function marktplatzFuer(
  supabase: any,
  tenant_id: string,
  opts?: MarktplatzOpts,
): Promise<string> {
  const gewuenscht = String(opts?.marktplatz ?? "").trim();
  if (gewuenscht) return gewuenscht;

  const { data, error } = await supabase.rpc("ads_haupt_marktplatz", { p_tenant: tenant_id });
  // Ein Fehler hier darf den Leser nicht kippen: der Fallback ist derselbe
  // Marktplatz, den die SQL-Funktion selbst als letzte Stufe liefert.
  if (error || !data) return FALLBACK;
  return String(data);
}

/**
 * Freigeschaltete Marktplaetze des Mandanten — fuer `verfuegbare_marktplaetze`
 * in der Antwort. Der Leser soll sagen koennen, welches Land er zeigt UND
 * welche es sonst noch gibt; sonst merkt niemand, dass Frankreich fehlt.
 */
export async function verfuegbareMarktplaetze(
  supabase: any,
  tenant_id: string,
): Promise<Array<{ marktplatz: string; land: string | null; waehrung: string | null }>> {
  const { data, error } = await supabase
    .from("ads_profile")
    .select("marktplatz, country_code, waehrung, aktiv")
    .eq("tenant_id", tenant_id)
    .eq("aktiv", true);
  if (error || !data) return [];
  return (data as any[])
    .filter((p) => p.marktplatz)
    .map((p) => ({
      marktplatz: String(p.marktplatz),
      land: p.country_code ?? null,
      waehrung: p.waehrung ?? null,
    }))
    .sort((a, b) => a.marktplatz.localeCompare(b.marktplatz));
}

/** Gemeinsamer Kopf jeder Ads-Antwort: welches Land, welche Waehrung, was gaebe es sonst. */
export async function marktplatzKopf(
  supabase: any,
  tenant_id: string,
  opts?: MarktplatzOpts,
): Promise<{
  marktplatz: string;
  verfuegbare_marktplaetze: Array<{ marktplatz: string; land: string | null; waehrung: string | null }>;
}> {
  const [marktplatz, verfuegbar] = await Promise.all([
    marktplatzFuer(supabase, tenant_id, opts),
    verfuegbareMarktplaetze(supabase, tenant_id),
  ]);
  return { marktplatz, verfuegbare_marktplaetze: verfuegbar };
}

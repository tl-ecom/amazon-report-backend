// ads_steuerung.ts — wer darf an welcher Kampagne drehen.
//
// Regel (05.10.2026): Pulse steuert nur die verwalteten Produkte. Setzt die
// Helium-10-KI in einer Kampagne Gebote, fasst Pulse dort kein Gebot an — die
// KI ueberschriebe es am naechsten Tag. Struktur (Negatives, Keywords, Budget,
// Zustand, Platzierung) bleibt dort bei Pulse, weil die KI nur Gebote setzt.
// Alle anderen Kampagnen werden nur ausgewertet.

export type Modus = "h10" | "pulse" | "nur_analyse";

/**
 * Hat der Mandant Zeilen in ads_steuerung, ist jede NICHT gelistete Kampagne
 * nur_analyse (lieber einmal zu viel gesperrt). Ohne Zeilen gilt keine Regel.
 */
export function steuerung(rows: { campaign_id: string | number; modus: string }[]): (campaignId: string | number) => Modus {
  const m = new Map(rows.map((r) => [String(r.campaign_id), r.modus as Modus]));
  return (campaignId) => m.size === 0 ? "pulse" : (m.get(String(campaignId)) ?? "nur_analyse");
}

/** Einstufung eines Mandanten laden — fuer die Leser, die ihre Zeilen kennzeichnen. */
export async function ladeSteuerung(supabase: any, tenant_id: string): Promise<(campaignId: string | number) => Modus> {
  const { data, error } = await supabase.from("ads_steuerung").select("campaign_id, modus").eq("tenant_id", tenant_id);
  if (error) throw new Error(`ads_steuerung: ${error.message}`);
  return steuerung(data ?? []);
}

/** Grund, warum Pulse hier nicht schreiben darf — oder null, wenn es darf. */
export function sperre(modus: Modus, was: "gebot" | "struktur"): string | null {
  if (modus === "nur_analyse") return "Kampagne wird nur ausgewertet, nicht gesteuert (ads_steuerung).";
  if (modus === "h10" && was === "gebot") return "Gebote dieser Kampagne steuert Helium 10, nicht Pulse (ads_steuerung).";
  return null;
}

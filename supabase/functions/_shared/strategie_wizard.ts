// strategie_wizard.ts — Backend für den geführten Pfad (Schritt 1–2).
//   Schritt 1 Rolle: Rollen-Stammdaten lesen; Zuweisung läuft über
//     bestaetigeStrategie (strategie_flow.ts).
//   Schritt 2 Korridor: effektiver Korridor je Kennzahl = per-ASIN-Override
//     (strategie_korridor) ODER Rollen-Default (strategie_definitionen.korridore).
//     Setzen/Zurücksetzen des Overrides je ASIN+Kennzahl.
//
// Reine Helfer (effektiverKorridor, pruefeKorridor) sind unit-getestet.
// KEINE Benchmark-Zahl im Code — Defaults kommen aus der DB/Config (TL füllt).

import type { Kennzahl } from "../../../config/strategy-definitions.ts";

export interface KorridorWert { min: number | null; max: number | null }
export type Quelle = "override" | "rolle" | "leer";

/** Kennzahlen, die der Wizard in Schritt 2 abdeckt (Brief: „mindestens abzudecken"). */
export const WIZARD_KENNZAHLEN: Array<{ kennzahl: Kennzahl; label: string; einheit: string; gut: "hoch" | "tief" }> = [
  { kennzahl: "tacos", label: "TACoS", einheit: "%", gut: "tief" },
  { kennzahl: "acos", label: "ACoS", einheit: "%", gut: "tief" },
  { kennzahl: "cvr", label: "Conversion Rate", einheit: "%", gut: "hoch" },
  { kennzahl: "deckungsbeitrag_nach_werbung", label: "DB nach Werbung", einheit: "%", gut: "hoch" },
  { kennzahl: "bestandsreichweite", label: "Bestandsreichweite", einheit: "Tage", gut: "hoch" },
];
const ERLAUBTE = new Set(WIZARD_KENNZAHLEN.map((k) => k.kennzahl));

function nz(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** Effektiver Korridor: Override sticht Rollen-Default. Reine Funktion. */
export function effektiverKorridor(
  override: KorridorWert | null | undefined,
  rollenDefault: KorridorWert | null | undefined,
): { min: number | null; max: number | null; quelle: Quelle; ueberschrieben: boolean } {
  const ov = override ?? null;
  const hatOverride = ov != null && (ov.min != null || ov.max != null);
  if (hatOverride) return { min: ov!.min ?? null, max: ov!.max ?? null, quelle: "override", ueberschrieben: true };
  const rd = rollenDefault ?? null;
  const hatDefault = rd != null && (rd.min != null || rd.max != null);
  if (hatDefault) return { min: rd!.min ?? null, max: rd!.max ?? null, quelle: "rolle", ueberschrieben: false };
  return { min: null, max: null, quelle: "leer", ueberschrieben: false };
}

/** Validiert einen zu setzenden Korridor. Wirft mit klarer Meldung. */
export function pruefeKorridor(kennzahl: string, min: number | null, max: number | null): { min: number | null; max: number | null } {
  if (!ERLAUBTE.has(kennzahl as Kennzahl)) throw new Error(`Kennzahl „${kennzahl}" ist im Wizard nicht vorgesehen.`);
  if (min == null && max == null) throw new Error("Mindestens Unter- oder Obergrenze angeben (oder zurücksetzen).");
  if (min != null && max != null && min > max) throw new Error("Untergrenze darf nicht über der Obergrenze liegen.");
  return { min, max };
}

// --- DB-Wrapper ---

/** Rollen-Stammdaten (global): Key, Label, Beschreibung, leading_kpi, Default-Korridore. */
export async function wizardRollen(supabase: any): Promise<unknown> {
  const { data, error } = await supabase.from("strategie_definitionen")
    .select("rolle, label, beschreibung, leading_kpi, korridore, max_dauer_tage, aktiv");
  if (error) throw new Error(`Rollen: ${error.message}`);
  const rollen = (data ?? []).filter((r: any) => r.aktiv !== false).map((r: any) => ({
    rolle: r.rolle, label: r.label ?? r.rolle, beschreibung: r.beschreibung ?? "",
    leading_kpi: r.leading_kpi ?? null, max_dauer_tage: r.max_dauer_tage ?? null,
    korridore: r.korridore ?? {},
  }));
  return { rollen, kennzahlen: WIZARD_KENNZAHLEN };
}

/** ASIN-Liste für die Auswahl: Titel + aktuelle Rolle (+ Label). Nach Umsatz sortiert. */
export async function wizardProdukte(supabase: any, tenant_id: string): Promise<unknown> {
  const [asinsRes, ordersRes, aktivRes, defsRes] = await Promise.all([
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
    supabase.from("orders_history").select("asin, item_price_cents").eq("tenant_id", tenant_id).gte("purchase_date", vorTagen(90)),
    supabase.from("asin_strategien").select("asin, rolle").eq("tenant_id", tenant_id).is("gueltig_bis", null),
    supabase.from("strategie_definitionen").select("rolle, label"),
  ]);
  const titel = new Map<string, string>((asinsRes.data ?? []).map((a: any) => [String(a.asin), String(a.produktname ?? a.asin)]));
  const umsatz = new Map<string, number>();
  for (const o of ordersRes.data ?? []) {
    if (!o.asin) continue;
    umsatz.set(o.asin, (umsatz.get(o.asin) ?? 0) + (Number(o.item_price_cents) || 0));
  }
  const rolleVon = new Map<string, string>((aktivRes.data ?? []).map((r: any) => [String(r.asin), String(r.rolle)]));
  const label = new Map<string, string>((defsRes.data ?? []).map((d: any) => [String(d.rolle), String(d.label ?? d.rolle)]));

  const asins = [...new Set([...titel.keys(), ...umsatz.keys(), ...rolleVon.keys()])].map((asin) => {
    const rolle = rolleVon.get(asin) ?? null;
    return {
      asin,
      produktname: titel.get(asin) ?? asin,
      umsatz_90t: Math.round((umsatz.get(asin) ?? 0)) / 100,
      rolle,
      rolle_label: rolle ? (label.get(rolle) ?? rolle) : null,
    };
  }).sort((a, b) => b.umsatz_90t - a.umsatz_90t);
  return { asins };
}

/** Schritt 2: aktive Rolle + effektive Korridore je Wizard-Kennzahl für EINE ASIN. */
export async function wizardAsin(supabase: any, tenant_id: string, asin: string): Promise<unknown> {
  if (!asin) throw new Error("asin fehlt");
  const [aktivRes, ovRes] = await Promise.all([
    supabase.from("asin_strategien").select("rolle, gueltig_ab, review_faellig").eq("tenant_id", tenant_id).eq("asin", asin).is("gueltig_bis", null).maybeSingle(),
    supabase.from("strategie_korridor").select("kennzahl, min, max, ueberschrieben").eq("tenant_id", tenant_id).eq("asin", asin),
  ]);
  const rolle = aktivRes.data?.rolle ?? null;
  let rollenDefaults: Record<string, KorridorWert> = {};
  let label: string | null = null;
  if (rolle) {
    const { data: def } = await supabase.from("strategie_definitionen").select("label, korridore").eq("rolle", rolle).maybeSingle();
    label = def?.label ?? rolle;
    rollenDefaults = (def?.korridore ?? {}) as Record<string, KorridorWert>;
  }
  const overrides = new Map<string, KorridorWert>();
  for (const o of ovRes.data ?? []) overrides.set(String(o.kennzahl), { min: nz(o.min), max: nz(o.max) });

  const korridore = WIZARD_KENNZAHLEN.map((k) => {
    const eff = effektiverKorridor(overrides.get(k.kennzahl), rollenDefaults[k.kennzahl]);
    return { kennzahl: k.kennzahl, label: k.label, einheit: k.einheit, gut: k.gut, ...eff };
  });
  return {
    asin,
    rolle,
    rolle_label: label,
    review_faellig: aktivRes.data?.review_faellig ?? null,
    gueltig_ab: aktivRes.data?.gueltig_ab ?? null,
    korridore,
    hat_rolle: Boolean(rolle),
  };
}

/** Per-ASIN-Korridor setzen (Override). */
export async function setzeKorridor(supabase: any, tenant_id: string, user_id: string, args: any): Promise<unknown> {
  const asin = String(args?.asin ?? "").trim();
  const kennzahl = String(args?.kennzahl ?? "").trim();
  if (!asin) throw new Error("asin fehlt");
  const { min, max } = pruefeKorridor(kennzahl, nz(args?.min), nz(args?.max));
  // ASIN gehört dem Tenant?
  const { data: a } = await supabase.from("asins").select("asin").eq("tenant_id", tenant_id).eq("asin", asin).maybeSingle();
  if (!a) throw new Error("ASIN gehört nicht zu dieser Firma.");
  const { error } = await supabase.from("strategie_korridor").upsert({
    tenant_id, asin, kennzahl, min, max, ueberschrieben: true, updated_at: new Date().toISOString(), updated_by: user_id,
  }, { onConflict: "tenant_id,asin,kennzahl" });
  if (error) throw new Error(`Korridor setzen: ${error.message}`);
  return { ok: true };
}

/** Per-ASIN-Korridor-Override entfernen (zurück auf Rollen-Default). */
export async function zuruecksetzenKorridor(supabase: any, tenant_id: string, args: any): Promise<unknown> {
  const asin = String(args?.asin ?? "").trim();
  const kennzahl = String(args?.kennzahl ?? "").trim();
  if (!asin || !kennzahl) throw new Error("asin/kennzahl fehlt");
  const { error } = await supabase.from("strategie_korridor").delete()
    .eq("tenant_id", tenant_id).eq("asin", asin).eq("kennzahl", kennzahl);
  if (error) throw new Error(`Korridor zurücksetzen: ${error.message}`);
  return { ok: true };
}

function vorTagen(tage: number): string {
  return new Date(Date.now() - tage * 86_400_000).toISOString().slice(0, 10);
}

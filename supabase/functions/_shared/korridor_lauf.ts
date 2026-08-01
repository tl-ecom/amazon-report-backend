// korridor_lauf.ts — DB-Schicht für Modul 2 (Größenklassen-Korridor).
// Die Rechenregeln liegen rein und getestet in groessenklassen.ts.
//
// Zwei Voraussetzungen, die beide fehlen können. Fehlt eine, sagt das Modul das
// deutlich, statt einen halben Befund zu bauen:
//   1. Gebührenvorschau-Report (Amazons gemessene Maße je SKU)
//   2. Gebührentabelle für den Marktplatz (Klassengrenzen aus der Rate Card)

import { korridorReport, type Klasse, type Produkt } from "./groessenklassen.ts";

/** Marktplatz-ID -> Land. Spiegelt public.marktplatz_land aus der Migration. */
const LAND: Record<string, string> = {
  A1PA6795UKMFR9: "DE", A13V1IB3VIYZZH: "FR", APJ6JRA9NG5V4: "IT",
  A1RKKUPIHCS9HS: "ES", A1F83G8C2ARO7P: "UK", A1805IZSGTT6HS: "NL",
  A2NODRKZP88ZB9: "SE", A1C3SOZRARQ6R3: "PL", AMEN7PMS3EDWL: "BE",
  A28R8C7NBKEWEA: "IE",
};

/** Zeilen aus fee_schedule zu Klassen bündeln (eine Klasse, mehrere Gewichtsstufen). */
export function baueKlassen(zeilen: any[]): Klasse[] {
  const proTier = new Map<string, Klasse>();
  for (const z of zeilen) {
    const tier = String(z.size_tier);
    let k = proTier.get(tier);
    if (!k) {
      k = {
        size_tier: tier,
        label: z.amazon_klasse_de ?? null,
        max_longest_side_cm: z.max_longest_side_cm === null ? null : Number(z.max_longest_side_cm),
        max_median_side_cm: z.max_median_side_cm === null ? null : Number(z.max_median_side_cm),
        max_shortest_side_cm: z.max_shortest_side_cm === null ? null : Number(z.max_shortest_side_cm),
        stufen: [],
        grundgebuehr_eur: z.grundgebuehr_eur === null ? null : Number(z.grundgebuehr_eur),
        zuschlag_je_100g_eur: z.zuschlag_je_100g_eur === null ? null : Number(z.zuschlag_je_100g_eur),
        max_weight_g: null,
      };
      proTier.set(tier, k);
    }
    const g = z.max_weight_g === null ? null : Number(z.max_weight_g);
    if (z.fee_eur !== null && z.fee_eur !== undefined) {
      k.stufen.push({ max_weight_g: g, fee_eur: Number(z.fee_eur) });
    }
    // Klassengrenze = schwerste hinterlegte Stufe (null = ohne Obergrenze).
    if (g === null) k.max_weight_g = null;
    else if (k.max_weight_g !== null) k.max_weight_g = Math.max(k.max_weight_g, g);
  }
  return [...proTier.values()];
}

export async function groessenklassenKorridor(
  supabase: any, tenant_id: string, opts?: { tage?: unknown },
): Promise<unknown> {
  const tage = Number(opts?.tage) > 0 ? Math.min(Number(opts?.tage), 730) : 365;

  const { data: ctx } = await supabase.from("auth_contexts")
    .select("marketplace_id").eq("tenant_id", tenant_id).limit(1).maybeSingle();
  const markt = LAND[String(ctx?.marketplace_id ?? "")] ?? null;
  if (!markt) {
    return leerAntwort("Der Marktplatz dieser Firma ist nicht bekannt — ohne ihn lässt sich keine Gebührentabelle zuordnen.");
  }

  // Nur EINE Gültigkeitsperiode: Klassen über Zeiträume zu mischen ergäbe
  // Ersparnisse, die es so nie gab.
  const { data: schedule, error: sErr } = await supabase.from("fee_schedule")
    .select("*").eq("marketplace", markt)
    .lte("gueltig_ab", new Date().toISOString().slice(0, 10))
    .order("gueltig_ab", { ascending: false });
  if (sErr) throw new Error(`fee_schedule: ${sErr.message}`);
  const zeilen = (schedule ?? []) as any[];
  if (zeilen.length === 0) {
    return leerAntwort(`Für ${markt} ist keine Gebührentabelle hinterlegt. Ohne die Klassengrenzen lässt sich nicht sagen, wie weit ein Produkt von der nächsten Klasse entfernt ist.`);
  }
  const neuesteAb = zeilen[0].gueltig_ab;
  const klassen = baueKlassen(zeilen.filter((z) => z.gueltig_ab === neuesteAb));

  const { data: rows, error: pErr } = await supabase.rpc("korridor_produkte", {
    p_tenant: tenant_id, p_markt: markt, p_tage: tage,
  });
  if (pErr) throw new Error(`korridor_produkte: ${pErr.message}`);

  const produkte: Produkt[] = ((rows ?? []) as any[]).map((r) => ({
    sku: String(r.sku),
    asin: r.asin ?? null,
    produktname: r.produktname ?? null,
    laengste_seite_cm: r.laengste_seite_cm === null ? null : Number(r.laengste_seite_cm),
    mittlere_seite_cm: r.mittlere_seite_cm === null ? null : Number(r.mittlere_seite_cm),
    kuerzeste_seite_cm: r.kuerzeste_seite_cm === null ? null : Number(r.kuerzeste_seite_cm),
    gewicht_g: r.gewicht_g === null ? null : Number(r.gewicht_g),
    groessenklasse: r.groessenklasse ?? null,
    fulfilment_cents: r.fulfilment_cents === null ? null : Number(r.fulfilment_cents),
    einheiten: Number(r.einheiten) || 0,
    fenster_tage: Number(r.fenster_tage) || tage,
  }));

  if (produkte.length === 0) {
    return leerAntwort("Der Gebührenvorschau-Report liegt noch nicht vor. Er wird täglich abgeholt; ohne ihn kennt Pulse weder Maße noch Größenklasse.");
  }

  const report = korridorReport(produkte, klassen);
  return {
    marktplatz: markt,
    gueltig_ab: neuesteAb,
    fenster_tage: produkte[0].fenster_tage,
    klassen_hinterlegt: klassen.length,
    produkte_geprueft: produkte.length,
    ...report,
    // Der Hebel kommt aus dem Coaching-Modell und ist fuer diesen Befundtyp fest.
    hebel: "produkt_market_fit",
    hinweis: "Die Ersparnis enthält den Treibstoffaufschlag von 1,5 %, den Amazon seit dem 17.04.2026 auf die Versandgebühr erhebt.",
  };
}

function leerAntwort(grund: string) {
  return {
    marktplatz: null, gueltig_ab: null, fenster_tage: null,
    klassen_hinterlegt: 0, produkte_geprueft: 0,
    befunde: [], chancen: [], summe_ersparnis_jahr: null,
    nicht_bewertbar: 0, unsicher: 0,
    hebel: "produkt_market_fit", hinweis: null,
    nicht_bewertbar_grund: grund,
  };
}

// changeengine.ts — erkennt Änderungen zwischen aufeinanderfolgenden ASIN-
// Snapshots (SKU-genau) und erzeugt Change Events. Reine Diff-Logik (diffSku)
// getrennt von der DB-Orchestrierung (laufeChangeEngine) — der Kern ist testbar.
//
// EHRLICHKEIT ist der ganze Punkt:
//   * Bestand nur diffen, wenn BEIDE Werte bekannt sind. quantity=null bedeutet
//     unbekannt (FBA führt Bestand hier nicht) — daraus NIE ein bestand_null-Event.
//   * Preis nur diffen, wenn beide bekannt.
// Die Engine behauptet keine Ursache — sie dokumentiert nur die Änderung als Fakt.
// Der Grund/die Hypothese kommt getrennt in change_event_context.

export interface Kandidat {
  event_type: string;
  event_category: string;
  previous_value: string | null;
  new_value: string | null;
  relevance: string;
  requires_context: boolean;
  detection_rule: string;
}

type Regeln = Record<string, { relevance_default?: string; schwellen?: any }>;

function preisRelevanz(prev: number, curr: number, schwellen: any): string {
  if (!prev) return "mittel";
  const pct = (Math.abs(curr - prev) / Math.abs(prev)) * 100;
  const hoch = Number(schwellen?.pct_hoch ?? 10);
  const mittel = Number(schwellen?.pct_mittel ?? 3);
  if (pct >= hoch) return "hoch";
  if (pct >= mittel) return "mittel";
  return "niedrig";
}

function kandidat(
  event_type: string,
  event_category: string,
  previous_value: string | null,
  new_value: string | null,
  relevance: string,
  detection_rule: string,
): Kandidat {
  // Relevante Änderungen fragen nach Kontext ("war das ein Test?").
  const requires_context = relevance === "kritisch" || relevance === "hoch";
  return { event_type, event_category, previous_value, new_value, relevance, requires_context, detection_rule };
}

/** Vergleicht den vorigen mit dem aktuellen SKU-Snapshot und liefert Change-Kandidaten. */
export function diffSku(prev: any, curr: any, regeln: Regeln): Kandidat[] {
  const out: Kandidat[] = [];
  const def = (typ: string, fallback: string) => regeln[typ]?.relevance_default ?? fallback;

  // --- Preis (nur wenn beide bekannt) ---
  if (prev?.price != null && curr?.price != null && Number(prev.price) !== Number(curr.price)) {
    const r = preisRelevanz(Number(prev.price), Number(curr.price), regeln["preis_geaendert"]?.schwellen);
    out.push(kandidat("preis_geaendert", "angebot", String(prev.price), String(curr.price), r, "price geändert"));
  }

  // --- Bestand (NUR wenn beide bekannt — null = unbekannt, kein Event) ---
  if (prev?.quantity != null && curr?.quantity != null) {
    const p = Number(prev.quantity);
    const c = Number(curr.quantity);
    if (p > 0 && c === 0) {
      out.push(kandidat("bestand_null", "bestand", String(p), "0", def("bestand_null", "kritisch"), "quantity >0 → 0"));
    } else if (p === 0 && c > 0) {
      out.push(kandidat("bestand_wieder_verfuegbar", "bestand", "0", String(c), def("bestand_wieder_verfuegbar", "hoch"), "quantity 0 → >0"));
    }
  }

  // --- Status active <-> nicht-active ---
  const pa = String(prev?.status ?? "").toLowerCase() === "active";
  const ca = String(curr?.status ?? "").toLowerCase() === "active";
  if (pa && !ca) {
    out.push(kandidat("listing_deaktiviert", "listing", String(prev?.status ?? ""), String(curr?.status ?? ""), def("listing_deaktiviert", "kritisch"), "active → nicht-active"));
  } else if (!pa && ca) {
    out.push(kandidat("listing_aktiviert", "listing", String(prev?.status ?? ""), String(curr?.status ?? ""), def("listing_aktiviert", "mittel"), "nicht-active → active"));
  }

  // --- Fulfillment-Typ (is_fba, nur wenn beide bekannt) ---
  if (prev?.is_fba != null && curr?.is_fba != null && prev.is_fba !== curr.is_fba) {
    out.push(kandidat(
      "fulfillment_geaendert", "angebot",
      prev.is_fba ? "FBA" : "Merchant", curr.is_fba ? "FBA" : "Merchant",
      def("fulfillment_geaendert", "mittel"), "Fulfillment-Typ gewechselt",
    ));
  }

  return out;
}

export interface EngineErgebnis {
  paare: number;
  kandidaten: number;
  eingefuegt: number;
  fehler?: string;
}

/**
 * Läuft für einen Snapshot-Tag: paart je SKU heute vs. letzter vorheriger Snapshot
 * (RPC snapshot_paare), difft, schreibt Change Events. Dedup über duplicate_key —
 * ein erneuter Lauf für denselben Tag erzeugt keine Duplikate.
 */
export async function laufeChangeEngine(supabase: any, tenant_id: string, datum: string): Promise<EngineErgebnis> {
  const { data: regelnRows, error: rErr } = await supabase.from("change_rules").select("*");
  if (rErr) return { paare: 0, kandidaten: 0, eingefuegt: 0, fehler: `change_rules: ${rErr.message}` };
  const regeln: Regeln = {};
  for (const r of regelnRows ?? []) regeln[r.event_type] = r;

  const { data: paare, error: pErr } = await supabase.rpc("snapshot_paare", { p_tenant: tenant_id, p_datum: datum });
  if (pErr) return { paare: 0, kandidaten: 0, eingefuegt: 0, fehler: `snapshot_paare: ${pErr.message}` };

  const rows: any[] = [];
  for (const paar of paare ?? []) {
    for (const k of diffSku(paar.prev, paar.curr, regeln)) {
      rows.push({
        tenant_id,
        asin: paar.asin,
        seller_sku: paar.seller_sku,
        event_type: k.event_type,
        event_category: k.event_category,
        detection_rule: k.detection_rule,
        effective_at: datum,
        previous_value: k.previous_value,
        new_value: k.new_value,
        relevance: k.relevance,
        requires_context: k.requires_context,
        status: k.requires_context ? "kontext_erforderlich" : "neu",
        duplicate_key: `${paar.seller_sku}|${k.event_type}|${k.previous_value}=>${k.new_value}|${datum}`,
      });
    }
  }

  let eingefuegt = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error, count } = await supabase
      .from("change_events")
      .upsert(batch, { onConflict: "tenant_id,duplicate_key", ignoreDuplicates: true, count: "exact" });
    if (error) return { paare: (paare ?? []).length, kandidaten: rows.length, eingefuegt, fehler: `change_events: ${error.message}` };
    eingefuegt += count ?? 0;
  }

  return { paare: (paare ?? []).length, kandidaten: rows.length, eingefuegt };
}

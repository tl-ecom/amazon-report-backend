// sellerboard_import.ts — DB-Schicht für den EK-Import aus Sellerboard.
// Reine Parserlogik liegt in sellerboard.ts (unit-getestet).
//
// Zwei Wege, gleiche Verarbeitung:
//   * CSV-Inhalt direkt (Datei-Upload im Browser)
//   * gespeicherter Sellerboard-Link (Vault) -> wird serverseitig geladen
//
// Ehrlichkeit: Es wird IMMER erst geprüft und berichtet (Vorschau), bevor
// geschrieben wird. Nicht zuordenbare Zeilen werden benannt, nicht verschluckt.

import { parseEkCsv } from "./sellerboard.ts";

export interface ImportErgebnis {
  erkannt: { sku: string | null; asin: string | null; ek: string | null; datum: string | null };
  spalten: string[];
  gelesen: number;
  uebersprungen: number;
  zugeordnet: number;
  /** Zeilen, deren SKU zu keiner bekannten ASIN passt (Produkt nie verkauft?). */
  nicht_zuordenbar: string[];
  geschrieben: number;
  warnungen: string[];
  /** true = nur Vorschau, es wurde NICHTS geschrieben. */
  vorschau: boolean;
}

// Ohne Startdatum gilt der Preis fuer ALLE Bestellungen — sonst haette keine
// vergangene Bestellung einen EK und Rohertrag/Nettogewinn blieben leer.
// (asin_ek waehlt je Bestellung den juengsten Eintrag mit gueltig_ab <= Kaufdatum.)
const GILT_VON_ANFANG = "2000-01-01";

/**
 * Verarbeitet einen CSV-Text: parsen, SKU->ASIN auflösen, optional schreiben.
 * `schreiben=false` liefert die Vorschau — gleiche Zahlen, ohne Nebenwirkung.
 */
export async function importiereEkCsv(
  supabase: any, tenant_id: string, csv: string, schreiben: boolean,
): Promise<ImportErgebnis> {
  const p = parseEkCsv(csv);
  const basis: ImportErgebnis = {
    erkannt: p.erkannt, spalten: p.spalten, gelesen: p.zeilen.length,
    uebersprungen: p.uebersprungen, zugeordnet: 0, nicht_zuordenbar: [],
    geschrieben: 0, warnungen: [...p.warnungen], vorschau: !schreiben,
  };
  if (p.zeilen.length === 0) return basis;

  // SKU -> ASIN: aus Bestellungen und Lagerbericht (dieselbe Quelle wie bei den Gebühren).
  const [ordersRes, lagerRes] = await Promise.all([
    supabase.from("orders_history").select("sku, asin").eq("tenant_id", tenant_id).not("sku", "is", null).not("asin", "is", null),
    supabase.from("fba_bestand").select("sku, asin").eq("tenant_id", tenant_id).not("asin", "is", null),
  ]);
  const skuZuAsin = new Map<string, string>();
  for (const r of (ordersRes.data ?? []) as any[]) skuZuAsin.set(String(r.sku), String(r.asin));
  for (const r of (lagerRes.data ?? []) as any[]) if (!skuZuAsin.has(String(r.sku))) skuZuAsin.set(String(r.sku), String(r.asin));

  // Je (ASIN, gueltig_ab) die letzte Zeile gewinnt — asin_ek ist darauf unique.
  const proSchluessel = new Map<string, { tenant_id: string; asin: string; ek_cents: number; gueltig_ab: string }>();
  const fehlend = new Set<string>();
  const standard = GILT_VON_ANFANG;

  for (const z of p.zeilen) {
    const asin = z.asin || (z.sku ? skuZuAsin.get(z.sku) ?? null : null);
    if (!asin) {
      if (z.sku) fehlend.add(z.sku);
      continue;
    }
    const gueltig_ab = z.gueltig_ab ?? standard;
    proSchluessel.set(`${asin}|${gueltig_ab}`, { tenant_id, asin, ek_cents: z.ek_cents, gueltig_ab });
  }

  const rows = [...proSchluessel.values()];
  basis.zugeordnet = rows.length;
  basis.nicht_zuordenbar = [...fehlend].slice(0, 25);
  if (fehlend.size > 0) {
    basis.warnungen.push(
      `${fehlend.size} SKU(s) ohne bekannte ASIN — diese Produkte wurden nie verkauft oder liegen nicht im Lagerbericht.`,
    );
  }
  if (!schreiben || rows.length === 0) return basis;

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from("asin_ek")
      .upsert(rows.slice(i, i + BATCH).map((r) => ({ ...r, updated_at: new Date().toISOString() })),
        { onConflict: "tenant_id,asin,gueltig_ab" });
    if (error) throw new Error(`EK schreiben: ${error.message}`);
  }
  basis.geschrieben = rows.length;
  return basis;
}

/** Sellerboard-Link im Vault ablegen (nur Referenz in tenant_einstellungen). */
export async function speichereEkUrl(supabase: any, tenant_id: string, url: string): Promise<{ ok: true }> {
  const u = String(url ?? "").trim();
  if (!/^https:\/\//i.test(u)) throw new Error("Bitte eine vollständige https-Adresse eintragen.");
  const { data: secretId, error } = await supabase.rpc("upsert_vault_secret", {
    p_name: `sellerboard_ek_${tenant_id}`, p_secret: u,
  });
  if (error) throw new Error(`Link speichern: ${error.message}`);
  const { error: uErr } = await supabase.from("tenant_einstellungen")
    .upsert({ tenant_id, sellerboard_ek_url_secret: secretId, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id" });
  if (uErr) throw new Error(`Link speichern: ${uErr.message}`);
  return { ok: true };
}

/** Gespeicherten Link laden und importieren. */
export async function importiereEkVonUrl(
  supabase: any, tenant_id: string, schreiben: boolean,
): Promise<ImportErgebnis> {
  const { data: e } = await supabase.from("tenant_einstellungen")
    .select("sellerboard_ek_url_secret").eq("tenant_id", tenant_id).maybeSingle();
  if (!e?.sellerboard_ek_url_secret) throw new Error("Es ist kein Sellerboard-Link hinterlegt.");

  const { data: url, error } = await supabase.rpc("read_vault_secret", { p_secret_id: e.sellerboard_ek_url_secret });
  if (error || !url) throw new Error("Hinterlegter Link konnte nicht gelesen werden.");

  let csv: string;
  try {
    const resp = await fetch(String(url), { redirect: "follow" });
    if (!resp.ok) throw new Error(`Sellerboard antwortete mit HTTP ${resp.status}`);
    csv = await resp.text();
  } catch (err) {
    await merkeStatus(supabase, tenant_id, `Fehler: ${String((err as Error)?.message ?? err)}`);
    throw new Error(`Abruf fehlgeschlagen: ${String((err as Error)?.message ?? err)}`);
  }
  // Eine HTML-Loginseite statt CSV ist der häufigste Fall bei abgelaufenen Links.
  if (/^\s*<(!doctype|html)/i.test(csv)) {
    await merkeStatus(supabase, tenant_id, "Fehler: HTML statt CSV (Link abgelaufen?)");
    throw new Error("Der Link lieferte eine Webseite statt einer CSV — bitte den Export-Link in Sellerboard neu kopieren.");
  }

  const erg = await importiereEkCsv(supabase, tenant_id, csv, schreiben);
  if (schreiben) await merkeStatus(supabase, tenant_id, `OK: ${erg.geschrieben} Preise`);
  return erg;
}

async function merkeStatus(supabase: any, tenant_id: string, status: string): Promise<void> {
  await supabase.from("tenant_einstellungen").upsert({
    tenant_id, sellerboard_ek_zuletzt: new Date().toISOString(),
    sellerboard_ek_status: status.slice(0, 200), updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id" });
}

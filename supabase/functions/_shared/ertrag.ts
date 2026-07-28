// ertrag.ts — EK-Kosten (Einkaufspreis pro ASIN, datumsbezogen) + monatlicher
// Rohertrag. Rohertrag = Umsatz − Wareneinsatz (EK×Menge je Bestellung). Das ist
// bewusst NICHT „Nettogewinn" — Amazon-Gebühren + Ads fehlen noch. `ek_abdeckung`
// macht transparent, für welchen Anteil der Einheiten überhaupt ein EK hinterlegt ist.

function euroZuCents(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  if (!isFinite(n) || n < 0) throw new Error("Ungültiger EK-Betrag");
  return Math.round(n * 100);
}

/** EK-Einträge + die tatsächlich verkauften ASINs (damit man weiß, was zu bepreisen ist). */
export async function listeEk(supabase: any, tenant_id: string): Promise<unknown> {
  const [ekRes, ordersRes] = await Promise.all([
    supabase.from("asin_ek").select("id, asin, ek_cents, gueltig_ab, updated_at")
      .eq("tenant_id", tenant_id).order("asin").order("gueltig_ab", { ascending: false }),
    supabase.from("orders_history").select("asin, quantity").eq("tenant_id", tenant_id),
  ]);
  if (ekRes.error) throw new Error(`asin_ek read: ${ekRes.error.message}`);

  // Verkaufte Einheiten je ASIN aufsummieren (für die "welche ASIN braucht EK"-Liste).
  const proAsin = new Map<string, number>();
  for (const o of ordersRes.data ?? []) {
    if (!o.asin) continue;
    proAsin.set(o.asin, (proAsin.get(o.asin) ?? 0) + (Number(o.quantity) || 0));
  }
  const asins = [...proAsin.entries()]
    .map(([asin, einheiten]) => ({ asin, einheiten }))
    .sort((a, b) => b.einheiten - a.einheiten);

  return { ek: ekRes.data ?? [], asins };
}

/** EK anlegen/ändern (ein Wert je ASIN + gueltig_ab). */
export async function setzeEk(
  supabase: any, tenant_id: string, asin: string, ekEuro: unknown, gueltig_ab: string,
): Promise<unknown> {
  const a = (asin ?? "").trim();
  if (!a) throw new Error("ASIN fehlt");
  if (!gueltig_ab) throw new Error("gueltig_ab fehlt");
  const ek_cents = euroZuCents(ekEuro);
  const { data, error } = await supabase.from("asin_ek").upsert({
    tenant_id, asin: a, ek_cents, gueltig_ab, updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,asin,gueltig_ab" }).select().single();
  if (error) throw new Error(`asin_ek upsert: ${error.message}`);
  return { ek: data };
}

/** EK-Eintrag löschen. */
export async function loescheEk(supabase: any, tenant_id: string, id: string): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt");
  const { error } = await supabase.from("asin_ek").delete().eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`asin_ek delete: ${error.message}`);
  return { ok: true };
}

interface ErtragRow { monat: string; umsatz_cents: number; einheiten: number; wareneinsatz_cents: number; einheiten_mit_ek: number }

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Monatlicher Rohertrag/Rohmarge + Gebühren + Nettogewinn.
 * Rohertrag = Umsatz − Wareneinsatz (nur mit EK). Nettogewinn = Rohertrag + Gebühren
 * (Gebühren sind negativ). Ads fehlen noch — also noch KEIN vollständiger Gewinn. */
export async function ertragVerlauf(supabase: any, tenant_id: string): Promise<unknown> {
  const [ertragRes, finRes] = await Promise.all([
    supabase.rpc("ertrag_monatlich", { p_tenant: tenant_id }),
    supabase.from("finance_monatlich").select("monat, gebuehren_cents").eq("tenant_id", tenant_id),
  ]);
  if (ertragRes.error) throw new Error(`ertrag_monatlich: ${ertragRes.error.message}`);
  const gebuehrMap = new Map<string, number>();
  for (const f of finRes.data ?? []) gebuehrMap.set(f.monat, (Number(f.gebuehren_cents) || 0) / 100);

  const monate = ((ertragRes.data ?? []) as ErtragRow[]).map((r) => {
    const umsatz = (Number(r.umsatz_cents) || 0) / 100;
    const wareneinsatz = (Number(r.wareneinsatz_cents) || 0) / 100;
    const einheiten = Number(r.einheiten) || 0;
    const mitEk = Number(r.einheiten_mit_ek) || 0;
    const hatEk = mitEk > 0;
    const abdeckung = einheiten > 0 ? Math.round((mitEk / einheiten) * 1000) / 10 : null;
    const rohertrag = hatEk ? r2(umsatz - wareneinsatz) : null;
    const gebuehren = gebuehrMap.has(r.monat) ? r2(gebuehrMap.get(r.monat)!) : null; // signiert (negativ)
    const nettogewinn = rohertrag != null && gebuehren != null ? r2(rohertrag + gebuehren) : null;
    return {
      monat: r.monat,
      umsatz_bestellungen: r2(umsatz),
      wareneinsatz: r2(wareneinsatz),
      rohertrag,
      rohmarge: hatEk && umsatz > 0 && rohertrag != null ? Math.round((rohertrag / umsatz) * 1000) / 10 : null,
      gebuehren,
      // Umsatz − Gebühren: ehrliche Zwischenstufe (ohne EK/COGS), sobald Gebühren da.
      umsatz_nach_gebuehren: gebuehren != null ? r2(umsatz + gebuehren) : null,
      nettogewinn,
      nettomarge: nettogewinn != null && umsatz > 0 ? Math.round((nettogewinn / umsatz) * 1000) / 10 : null,
      ek_abdeckung: abdeckung,
    };
  });
  return { monate };
}

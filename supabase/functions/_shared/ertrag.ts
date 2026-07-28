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

/** Monatlicher Rohertrag/Rohmarge (aus Bestelldaten + EK). */
export async function ertragVerlauf(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("ertrag_monatlich", { p_tenant: tenant_id });
  if (error) throw new Error(`ertrag_monatlich: ${error.message}`);
  const monate = ((data ?? []) as ErtragRow[]).map((r) => {
    const umsatz = (Number(r.umsatz_cents) || 0) / 100;
    const wareneinsatz = (Number(r.wareneinsatz_cents) || 0) / 100;
    const einheiten = Number(r.einheiten) || 0;
    const mitEk = Number(r.einheiten_mit_ek) || 0;
    const abdeckung = einheiten > 0 ? Math.round((mitEk / einheiten) * 1000) / 10 : null;
    const rohertrag = Math.round((umsatz - wareneinsatz) * 100) / 100;
    return {
      monat: r.monat,
      umsatz_bestellungen: Math.round(umsatz * 100) / 100,
      wareneinsatz: Math.round(wareneinsatz * 100) / 100,
      rohertrag,
      rohmarge: umsatz > 0 ? Math.round((rohertrag / umsatz) * 1000) / 10 : null,
      ek_abdeckung: abdeckung, // % der Einheiten mit hinterlegtem EK
    };
  });
  return { monate };
}

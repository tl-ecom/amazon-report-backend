// einstellungen.ts — manuelle Firmen-Einstellungen: Ziel-ACOS und Kosten-Abschlag.
// Der Kosten-Abschlag (%) lässt den Seller Amazon-Gebühren/Retouren/Anlieferkosten
// selbst berücksichtigen, solange diese noch nicht automatisch aus der SP-API kommen.
// Break-even ACOS = Rohmarge − Kosten-Abschlag (im Frontend gerechnet).

function pruefeProzent(v: unknown, feld: string, erlaubtNull = false): number | null {
  if ((v === null || v === undefined || v === "") && erlaubtNull) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  if (!isFinite(n) || n < 0 || n > 100) throw new Error(`${feld}: Bitte 0–100 % angeben`);
  return Math.round(n * 100) / 100;
}

export async function ladeEinstellungen(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("tenant_einstellungen")
    .select("ziel_acos_prozent, kosten_abschlag_prozent, ziel_marge_prozent")
    .eq("tenant_id", tenant_id).maybeSingle();
  if (error) throw new Error(`einstellungen read: ${error.message}`);
  return {
    ziel_acos_prozent: data?.ziel_acos_prozent ?? null,
    kosten_abschlag_prozent: data?.kosten_abschlag_prozent ?? 0,
    // Untergrenze für den Deckungsbeitrag nach Werbung. null = keine Vorgabe;
    // dann bleibt die Gebühren-Vorschau bei „keine Zielmarge hinterlegt".
    ziel_marge_prozent: data?.ziel_marge_prozent ?? null,
  };
}

export async function setzeEinstellungen(
  supabase: any, tenant_id: string,
  args: { ziel_acos_prozent?: unknown; kosten_abschlag_prozent?: unknown; ziel_marge_prozent?: unknown },
): Promise<{ ok: true }> {
  const ziel = pruefeProzent(args.ziel_acos_prozent, "Ziel-ACOS", true);
  const abschlag = pruefeProzent(args.kosten_abschlag_prozent ?? 0, "Kosten-Abschlag") ?? 0;
  const satz: Record<string, unknown> = {
    tenant_id, ziel_acos_prozent: ziel, kosten_abschlag_prozent: abschlag,
    updated_at: new Date().toISOString(),
  };
  // Nur schreiben, wenn das Feld überhaupt geschickt wurde: Sonst löschte jedes
  // Speichern der ACOS-Ziele die Zielmarge gleich mit.
  if ("ziel_marge_prozent" in args) {
    satz.ziel_marge_prozent = pruefeProzent(args.ziel_marge_prozent, "Zielmarge", true);
  }
  const { error } = await supabase.from("tenant_einstellungen").upsert(satz, { onConflict: "tenant_id" });
  if (error) throw new Error(`einstellungen upsert: ${error.message}`);
  return { ok: true };
}

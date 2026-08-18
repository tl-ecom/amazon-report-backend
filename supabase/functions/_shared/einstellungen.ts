// einstellungen.ts — manuelle Einstellungen, auf zwei Ebenen.
//
// FIRMA (tenant_einstellungen): Ziel-ACOS als Vorgabe, Zielmarge, Steuerprofil.
// Der Kosten-Abschlag steht hier nur noch aus Bestandsgründen — der Break-even
// wird längst aus den echten Gebühren je SKU gerechnet, nicht aus einem
// geschätzten Prozentsatz.
//
// PRODUKT (asin_einstellungen): Ziel-ACOS und Umsatzsteuersatz je ASIN. Beides
// ist produktabhängig — ein Artikel mit 36 % Rohmarge verträgt keinen Ziel-ACOS,
// der für einen mit 80 % passt, und 7 % USt gilt nur für bestimmte Waren.

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

/** Nur diese Sätze kommen in Deutschland vor. Ein Tippfehler wie 1,9 statt 19
 *  wäre sonst nicht von einer Absicht zu unterscheiden und verfälschte jede
 *  Marge — lieber ablehnen als stillschweigend übernehmen. */
const UST_SAETZE = [0, 7, 19];

/**
 * Ziel-ACOS und/oder Umsatzsteuersatz für EIN Produkt setzen.
 *
 * Leerer String löscht den Wert (null = keine Angabe), damit man eine Vorgabe
 * auch wieder zurücknehmen kann. Nur mitgeschickte Felder werden angefasst:
 * sonst löschte das Speichern des Ziel-ACOS den Steuersatz gleich mit.
 */
export async function setzeAsinEinstellung(
  supabase: any, tenant_id: string,
  args: { asin?: unknown; ziel_acos_prozent?: unknown; ust_prozent?: unknown },
): Promise<{ ok: true; asin: string }> {
  const asin = String(args.asin ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("Bitte eine gültige ASIN angeben (10 Zeichen).");

  const satz: Record<string, unknown> = { tenant_id, asin, updated_at: new Date().toISOString() };

  if ("ziel_acos_prozent" in args) {
    satz.ziel_acos_prozent = pruefeProzent(args.ziel_acos_prozent, "Ziel-ACOS", true);
  }
  if ("ust_prozent" in args) {
    const roh = args.ust_prozent;
    if (roh === null || roh === undefined || roh === "") {
      satz.ust_prozent = null;
    } else {
      const n = typeof roh === "number" ? roh : parseFloat(String(roh).replace(",", "."));
      if (!UST_SAETZE.includes(n)) {
        throw new Error(`Umsatzsteuersatz: erlaubt sind ${UST_SAETZE.join(", ")} % (oder leer für den Firmenwert).`);
      }
      satz.ust_prozent = n;
    }
  }

  const { error } = await supabase.from("asin_einstellungen").upsert(satz, { onConflict: "tenant_id,asin" });
  if (error) throw new Error(`asin_einstellungen upsert: ${error.message}`);
  return { ok: true, asin };
}

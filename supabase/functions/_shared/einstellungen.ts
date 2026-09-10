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

// --- Steuerliche Stammdaten -------------------------------------------------
//
// Was Pulse NICHT messen kann und trotzdem braucht: ob die Firma
// vorsteuerabzugsberechtigt ist, in welchem Rhythmus sie voranmeldet, ob sie
// OSS nutzt, ob Ware im Ausland liegt. Alles davon veraendert die Cash-Sicht,
// und nichts davon steht in irgendeinem Amazon-Bericht.
//
// Jedes Feld darf null bleiben. Das ist Absicht: "OSS: nein" und "OSS: nicht
// angegeben" sind verschiedene Aussagen, und die zweite darf nicht als die
// erste ausgegeben werden.

const VORANMELDUNG = ["monatlich", "vierteljaehrlich", "jaehrlich", "keine"];

/** Tri-State: true / false / null. Ein leeres Feld loescht die Angabe. */
function jaNeinOffen(v: unknown, feld: string): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "ja", "1"].includes(s)) return true;
  if (["false", "nein", "0"].includes(s)) return false;
  throw new Error(`${feld}: bitte ja, nein oder leer lassen.`);
}

export async function ladeStammdaten(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("tenant_einstellungen")
    .select("umsatzsteuerpflichtig, vorsteuerabzug, firmensitz_land, umsatzsteuer_prozent, "
      + "ust_voranmeldung, ust_dauerfristverlaengerung, ermaessigter_satz, oss_teilnahme, "
      + "pan_eu, lager_ausland, lager_laender, stammdaten_bestaetigt_am")
    .eq("tenant_id", tenant_id).maybeSingle();
  if (error) throw new Error(`stammdaten read: ${error.message}`);
  return {
    umsatzsteuerpflichtig: data?.umsatzsteuerpflichtig ?? null,
    vorsteuerabzug: data?.vorsteuerabzug ?? null,
    firmensitz_land: data?.firmensitz_land ?? null,
    umsatzsteuer_prozent: data?.umsatzsteuer_prozent ?? null,
    ust_voranmeldung: data?.ust_voranmeldung ?? null,
    ust_dauerfristverlaengerung: data?.ust_dauerfristverlaengerung ?? null,
    ermaessigter_satz: data?.ermaessigter_satz ?? null,
    oss_teilnahme: data?.oss_teilnahme ?? null,
    pan_eu: data?.pan_eu ?? null,
    lager_ausland: data?.lager_ausland ?? null,
    lager_laender: data?.lager_laender ?? null,
    bestaetigt_am: data?.stammdaten_bestaetigt_am ?? null,
  };
}

export async function setzeStammdaten(
  supabase: any, tenant_id: string, args: Record<string, unknown>,
): Promise<{ ok: true }> {
  const satz: Record<string, unknown> = { tenant_id, updated_at: new Date().toISOString() };

  // Nur mitgeschickte Felder anfassen — sonst loescht das Speichern eines
  // Hakens alle anderen Angaben gleich mit.
  for (const feld of [
    "umsatzsteuerpflichtig", "ust_dauerfristverlaengerung", "ermaessigter_satz",
    "oss_teilnahme", "pan_eu", "lager_ausland",
  ]) {
    if (feld in args) satz[feld] = jaNeinOffen(args[feld], feld);
  }

  if ("ust_voranmeldung" in args) {
    const roh = args.ust_voranmeldung;
    if (roh === null || roh === undefined || roh === "") {
      satz.ust_voranmeldung = null;
    } else {
      const s = String(roh).trim();
      if (!VORANMELDUNG.includes(s)) {
        throw new Error(`Voranmeldung: erlaubt sind ${VORANMELDUNG.join(", ")} (oder leer).`);
      }
      satz.ust_voranmeldung = s;
    }
  }

  if ("lager_laender" in args) {
    const roh = args.lager_laender;
    if (roh === null || roh === undefined || roh === "") {
      satz.lager_laender = null;
    } else {
      const liste = (Array.isArray(roh) ? roh : String(roh).split(","))
        .map((x) => String(x).trim().toUpperCase()).filter(Boolean);
      if (liste.some((c) => !/^[A-Z]{2}$/.test(c))) {
        throw new Error("Lagerländer: bitte zweistellige Ländercodes angeben (z. B. DE, PL, CZ).");
      }
      satz.lager_laender = liste;
    }
  }

  // Kleinunternehmer hat keinen Vorsteuerabzug. Die beiden Felder duerfen sich
  // nicht widersprechen, sonst rechnet die Cash-Sicht mit einer Erstattung,
  // die es nicht gibt.
  if (satz.umsatzsteuerpflichtig === false) satz.vorsteuerabzug = false;

  if (args.bestaetigen === true) satz.stammdaten_bestaetigt_am = new Date().toISOString();

  const { error } = await supabase.from("tenant_einstellungen")
    .upsert(satz, { onConflict: "tenant_id" });
  if (error) throw new Error(`stammdaten upsert: ${error.message}`);
  return { ok: true };
}

// --- Kontostand -------------------------------------------------------------
//
// Der einzige Wert der Cash-Sicht, den Pulse nicht messen kann: was auf dem
// Geschaeftskonto liegt, steht in keinem Amazon-Bericht. Ohne ihn gibt es
// keinen Liquiditaetsverlauf — und ein Verlauf ab 0 € waere schlimmer als
// keiner, weil er wie eine Rechnung aussieht.
//
// Gemeint ist der BANK-Stand ohne Amazon-Guthaben. Was noch bei Amazon liegt,
// kommt ueber die Auszahlungen im Kalender herein; beides zu addieren zaehlte
// dasselbe Geld zweimal.

/** Euro-Eingabe zu Cent. Leer = null (Angabe loeschen), nicht 0. */
function zuCentsOderNull(v: unknown, feld: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\./g, "").replace(",", "."));
  if (!isFinite(n)) throw new Error(`${feld}: bitte einen Betrag in Euro angeben.`);
  return Math.round(n * 100);
}

export async function ladeKontostand(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("tenant_einstellungen")
    .select("kontostand_cents, kontostand_am, kontostand_puffer_cents")
    .eq("tenant_id", tenant_id).maybeSingle();
  if (error) throw new Error(`kontostand read: ${error.message}`);
  return {
    kontostand: data?.kontostand_cents == null ? null : Number(data.kontostand_cents) / 100,
    kontostand_am: data?.kontostand_am ?? null,
    puffer: data?.kontostand_puffer_cents == null ? null : Number(data.kontostand_puffer_cents) / 100,
  };
}

export async function setzeKontostand(
  supabase: any, tenant_id: string,
  args: { kontostand?: unknown; kontostand_am?: unknown; puffer?: unknown },
): Promise<{ ok: true }> {
  const satz: Record<string, unknown> = { tenant_id, updated_at: new Date().toISOString() };

  if ("kontostand" in args) satz.kontostand_cents = zuCentsOderNull(args.kontostand, "Kontostand");
  if ("puffer" in args) satz.kontostand_puffer_cents = zuCentsOderNull(args.puffer, "Puffer");

  if ("kontostand_am" in args) {
    const roh = args.kontostand_am;
    if (roh === null || roh === undefined || roh === "") {
      satz.kontostand_am = null;
    } else {
      const d = String(roh).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        throw new Error("Stichtag: bitte als Datum angeben (JJJJ-MM-TT).");
      }
      satz.kontostand_am = d;
    }
  }

  // Ein Betrag ohne Stichtag ist nicht auswertbar: der Verlauf muss wissen, ab
  // WANN der Stand gilt. Statt still einen Tag zu erfinden, wird heute gesetzt
  // — das ist der Fall, den jemand meint, der eben aufs Konto geschaut hat.
  if (satz.kontostand_cents != null && !("kontostand_am" in args)) {
    satz.kontostand_am = new Date().toISOString().slice(0, 10);
  }

  const { error } = await supabase.from("tenant_einstellungen")
    .upsert(satz, { onConflict: "tenant_id" });
  if (error) throw new Error(`kontostand upsert: ${error.message}`);
  return { ok: true };
}

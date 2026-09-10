import io

p = "supabase/functions/_shared/einstellungen.ts"
s = io.open(p, encoding="utf-8").read()

s = s.rstrip() + '''

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
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\\./g, "").replace(",", "."));
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
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) {
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
'''
io.open(p, "w", encoding="utf-8", newline="\n").write(s)

# --- API-Routen ------------------------------------------------------------
p = "supabase/functions/api/index.ts"
s = io.open(p, encoding="utf-8").read()

alt = """      if (action === "einstellungen_setzen") {"""
neu = """      // Kontostand des Geschaeftskontos — Startwert des Liquiditaetsverlaufs.
      if (action === "kontostand_setzen") {
        const r = await setzeKontostand(service, tenantId, args as any);
        return json({ ok: true, action, tenant_id: tenantId, data: r });
      }
      if (action === "einstellungen_setzen") {"""
assert alt in s, "Action"
s = s.replace(alt, neu, 1)

alt = """    if (resource === "stammdaten") {"""
neu = """    if (resource === "kontostand") {
      return json({ ok: true, resource, tenant_id: tenantId, data: await ladeKontostand(service, tenantId) });
    }
    if (resource === "stammdaten") {"""
assert alt in s, "Resource"
s = s.replace(alt, neu, 1)

import re
m = re.search(r'import \{([^}]*)\} from "\.\./_shared/einstellungen\.ts";', s)
assert m, "Einstellungen-Import"
inner = m.group(1)
assert "ladeKontostand" not in inner
neu_inner = inner.rstrip().rstrip(",") + ", ladeKontostand, setzeKontostand"
s = s[:m.start(1)] + neu_inner + s[m.end(1):]

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("Kontostand angebunden")

// befund_lauf.ts — Schritt 3: Befund erzeugen (DB + KI). Die reine Logik
// (Fakten, Guardrail, Fallback-Text) liegt in befund.ts und ist unit-getestet.
//
// Ablauf:
//   1. effektive Korridore + Ist-Werte laden -> Fakten (deterministisch)
//   2. Claude formulieren lassen (nur Fakten im Prompt)
//   3. GUARDRAIL: jede Zahl im Text muss in den Fakten stehen. Sonst EINMAL neu
//      generieren; scheitert das wieder -> deterministischer Text.
//   4. speichern mit modell + prompt_version + guardrail-Status.
//
// Ohne ANTHROPIC_API_KEY läuft alles weiter — dann eben deterministisch.

import {
  baueFakten, baueSystemPrompt, baueUserPrompt, deterministischerBefund,
  type Fakten, PROMPT_VERSION, pruefeText,
} from "./befund.ts";
import { wizardAsin, WIZARD_KENNZAHLEN } from "./strategie_wizard.ts";

const MODELL = Deno.env.get("BEFUND_MODELL") ?? "claude-sonnet-5";
const ST_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";

/** Ist-Werte je Wizard-Kennzahl. Ehrlich: was wir nicht wissen, bleibt null. */
async function ladeIst(supabase: any, tenant_id: string, asin: string): Promise<{
  ist: Record<string, number | null>;
  euro: Record<string, number | null>;
  produktname: string;
}> {
  const [stRes, prodRes, asinRes] = await Promise.all([
    supabase.from("report_data").select("payload").eq("tenant_id", tenant_id)
      .eq("report_type", ST_TYPE).eq("is_latest", true).maybeSingle(),
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: vorTagen(30), p_bis: vorTagen(0) }),
    supabase.from("asins").select("produktname").eq("tenant_id", tenant_id).eq("asin", asin).maybeSingle(),
  ]);

  // CVR + Sessions je ASIN aus Sales & Traffic.
  let cvr: number | null = null, sessions: number | null = null;
  for (const el of (stRes.data?.payload?.salesAndTrafficByAsin ?? []) as any[]) {
    if (String(el.childAsin ?? el.parentAsin ?? "") !== asin) continue;
    const t = el.trafficByAsin ?? {};
    cvr = t.unitSessionPercentage != null ? Number(t.unitSessionPercentage) : null;
    sessions = t.sessions != null ? Number(t.sessions) : null;
  }

  // Ø-Preis für die Euro-Auswirkung.
  let preis: number | null = null;
  for (const r of (prodRes.data ?? []) as any[]) {
    if (String(r.asin) !== asin) continue;
    const u = Number(r.umsatz_cents) || 0, e = Number(r.einheiten) || 0;
    if (e > 0) preis = u / 100 / e;
  }

  return {
    produktname: asinRes.data?.produktname ?? asin,
    ist: {
      // Ads-abhängig -> bis zur Ads-Freigabe ehrlich unbekannt.
      tacos: null, acos: null, deckungsbeitrag_nach_werbung: null,
      // Bestand: kein Live-Inventar (FBA-Rolle fehlt) -> unbekannt.
      bestandsreichweite: null,
      cvr,
    },
    // Euro-Auswirkung nur, wo deterministisch begründbar: fehlende Einheiten
    // durch CVR-Lücke × Ø-Preis, auf 30 Tage. Sonst null (nie schätzen).
    euro: { _sessions: sessions, _preis: preis } as any,
  };
}

/** Euro/Monat je Kennzahl — nur wo begründbar (aktuell: CVR-Lücke). */
function euroAuswirkung(
  korridore: Array<{ kennzahl: string; min: number | null; max: number | null }>,
  ist: Record<string, number | null>,
  sessions: number | null,
  preis: number | null,
): Record<string, number | null> {
  const raus: Record<string, number | null> = {};
  const k = korridore.find((x) => x.kennzahl === "cvr");
  const cvr = ist.cvr;
  if (k?.min != null && cvr != null && cvr < k.min && sessions != null && preis != null) {
    const fehlendeEinheiten = sessions * ((k.min - cvr) / 100);
    raus.cvr = Math.round(fehlendeEinheiten * preis * 100) / 100;
  }
  return raus;
}

/** Ruft Claude. Gibt null zurück, wenn kein Key gesetzt ist oder der Call scheitert. */
async function rufeKi(f: Fakten): Promise<{ diagnose: string; text: string } | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELL,
        max_tokens: 700,
        system: baueSystemPrompt(),
        messages: [{ role: "user", content: baueUserPrompt(f) }],
      }),
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    const roh = (d?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
    const j = roh.match(/\{[\s\S]*\}/);
    if (!j) return null;
    const parsed = JSON.parse(j[0]);
    if (typeof parsed?.text !== "string") return null;
    return { diagnose: String(parsed.diagnose ?? "").trim(), text: String(parsed.text).trim() };
  } catch {
    return null;
  }
}

/** Erzeugt (und speichert) den Befund für EINE ASIN. */
export async function erzeugeBefund(supabase: any, tenant_id: string, user_id: string, args: any): Promise<unknown> {
  const asin = String(args?.asin ?? "").trim();
  if (!asin) throw new Error("asin fehlt");

  const wiz = await wizardAsin(supabase, tenant_id, asin) as any;
  if (!wiz.hat_rolle) throw new Error("Ohne Rolle kein Befund — zuerst Schritt 1.");

  const { ist, euro, produktname } = await ladeIst(supabase, tenant_id, asin);
  const korridore = (wiz.korridore ?? []).map((k: any) => ({
    kennzahl: k.kennzahl, label: k.label, einheit: k.einheit, min: k.min, max: k.max,
  }));
  const euro_monat = euroAuswirkung(korridore, ist, (euro as any)._sessions, (euro as any)._preis);

  // Vorheriger Befund -> „auffällig ruhig".
  const { data: letzter } = await supabase.from("strategie_befund")
    .select("fakten").eq("tenant_id", tenant_id).eq("asin", asin)
    .order("erstellt_am", { ascending: false }).limit(1).maybeSingle();
  const vorher: Record<string, any> = {};
  for (const k of (letzter?.fakten?.kennzahlen ?? []) as any[]) vorher[k.kennzahl] = k.status;

  const stichtag = new Date().toISOString().slice(0, 10);
  const fakten = baueFakten({
    asin, produktname, rolle: wiz.rolle, rolle_label: wiz.rolle_label ?? wiz.rolle,
    stichtag, korridore, ist, euro_monat, vorher,
  });

  // KI formulieren lassen — mit Guardrail und EINEM Nachversuch.
  let diagnose = "", text = "", guardrail = "deterministisch", modell: string | null = null;
  let verworfen: number[] = [];
  const det = deterministischerBefund(fakten);
  for (let versuch = 0; versuch < 2; versuch++) {
    const ki = await rufeKi(fakten);
    if (!ki) break;
    // BEIDE Felder prüfen — auch die Diagnose ist ausgelieferter Text.
    const pr = pruefeText(`${ki.diagnose}\n${ki.text}`, fakten);
    if (pr.ok) {
      diagnose = ki.diagnose || det.diagnose;
      text = ki.text;
      guardrail = "ok";
      modell = MODELL;
      break;
    }
    verworfen = pr.unbelegt;
    guardrail = "ki_verworfen";
  }
  if (!text) {
    diagnose = det.diagnose;
    text = det.text;
  }

  const { data: row, error } = await supabase.from("strategie_befund").insert({
    tenant_id, asin, stichtag, rolle: wiz.rolle, diagnose, text,
    fakten, modell, prompt_version: PROMPT_VERSION, guardrail, erstellt_von: user_id,
  }).select("*").maybeSingle();
  if (error) throw new Error(`Befund speichern: ${error.message}`);

  return { ok: true, befund: row, verworfene_zahlen: verworfen };
}

/** Letzter Befund einer ASIN (für Schritt 3 in der Oberfläche). */
export async function letzterBefund(supabase: any, tenant_id: string, asin: string): Promise<unknown> {
  if (!asin) return { befund: null };
  const { data, error } = await supabase.from("strategie_befund")
    .select("id, asin, stichtag, rolle, diagnose, text, fakten, modell, prompt_version, guardrail, erstellt_am")
    .eq("tenant_id", tenant_id).eq("asin", asin)
    .order("erstellt_am", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Befund lesen: ${error.message}`);
  return { befund: data ?? null, kennzahlen: WIZARD_KENNZAHLEN };
}

function vorTagen(t: number): string {
  return new Date(Date.now() - t * 86_400_000).toISOString().slice(0, 10);
}

// befund.ts — Schritt 3 des geführten Pfads: der BEFUND.
//
// Kernregel des Briefs: **Die KI formuliert. Sie rechnet nicht.** Jede Zahl im
// Befundtext stammt aus der deterministischen Schicht (`Fakten`) und wird vor dem
// Speichern gegen diese validiert; weicht sie ab, wird der Befund verworfen
// (einmal neu generiert, sonst deterministischer Fallback-Text).
//
// Alles hier ist REIN und unit-getestet — der Netzwerk-/DB-Teil liegt in
// befund_lauf.ts. Ton: nüchtern, keine Ausrufezeichen, Signatur „–TL".

export const PROMPT_VERSION = "befund-v1";
export const SIGNATUR = "–TL";

export interface FaktKennzahl {
  kennzahl: string;
  label: string;
  ist: number | null;
  min: number | null;
  max: number | null;
  einheit: string;
  status: "ausserhalb" | "im_korridor" | "nicht_bewertbar";
  /** Auswirkung in Euro pro Monat, soweit berechenbar (Brief: Sortierung danach). */
  delta_eur_monat: number | null;
}

export interface Fakten {
  asin: string;
  produktname: string;
  rolle: string;
  rolle_label: string;
  stichtag: string;
  kennzahlen: FaktKennzahl[];
  /** Kennzahlen, die den Korridor verlassen — nach €-Auswirkung sortiert. */
  ausserhalb: FaktKennzahl[];
  /** „Auffällig ruhig": Statuswechsel ggü. dem letzten Befund. */
  ruhig: Array<{ kennzahl: string; label: string; text: string }>;
  nicht_bewertbar: string[];
}

/** Zahl auf 2 Stellen normalisieren (Vergleichsbasis für den Guardrail). */
function norm(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Baut die Fakten aus den EFFEKTIVEN Korridoren + Ist-Werten. Rein.
 * `vorher` = Status je Kennzahl aus dem letzten Befund (für „auffällig ruhig").
 */
export function baueFakten(p: {
  asin: string;
  produktname: string;
  rolle: string;
  rolle_label: string;
  stichtag: string;
  korridore: Array<{ kennzahl: string; label: string; einheit: string; min: number | null; max: number | null }>;
  ist: Record<string, number | null>;
  /** Euro-Auswirkung je Kennzahl pro Monat (deterministisch berechnet, sonst null). */
  euro_monat?: Record<string, number | null>;
  vorher?: Record<string, "ausserhalb" | "im_korridor" | "nicht_bewertbar">;
}): Fakten {
  const kennzahlen: FaktKennzahl[] = p.korridore.map((k) => {
    const ist = p.ist[k.kennzahl] ?? null;
    const hatKorridor = k.min != null || k.max != null;
    let status: FaktKennzahl["status"];
    if (ist == null || !hatKorridor) status = "nicht_bewertbar";
    else if ((k.min != null && ist < k.min) || (k.max != null && ist > k.max)) status = "ausserhalb";
    else status = "im_korridor";
    return {
      kennzahl: k.kennzahl, label: k.label, einheit: k.einheit,
      ist: ist == null ? null : norm(ist),
      min: k.min == null ? null : norm(k.min),
      max: k.max == null ? null : norm(k.max),
      status,
      delta_eur_monat: p.euro_monat?.[k.kennzahl] == null ? null : norm(p.euro_monat[k.kennzahl]!),
    };
  });

  // Brief: nach FINANZIELLER Auswirkung sortieren, nicht nach Prozent-Abweichung.
  const ausserhalb = kennzahlen.filter((k) => k.status === "ausserhalb")
    .sort((a, b) => (b.delta_eur_monat ?? -1) - (a.delta_eur_monat ?? -1));

  const ruhig: Fakten["ruhig"] = [];
  for (const k of kennzahlen) {
    const alt = p.vorher?.[k.kennzahl];
    if (!alt || alt === k.status) continue;
    if (alt === "ausserhalb" && k.status === "im_korridor") {
      ruhig.push({ kennzahl: k.kennzahl, label: k.label, text: `${k.label} ist zurück im Korridor.` });
    } else if (alt === "im_korridor" && k.status === "ausserhalb") {
      ruhig.push({ kennzahl: k.kennzahl, label: k.label, text: `${k.label} hat den Korridor neu verlassen.` });
    }
  }

  return {
    asin: p.asin, produktname: p.produktname, rolle: p.rolle, rolle_label: p.rolle_label,
    stichtag: p.stichtag, kennzahlen, ausserhalb, ruhig,
    nicht_bewertbar: kennzahlen.filter((k) => k.status === "nicht_bewertbar").map((k) => k.label),
  };
}

/**
 * Alle in den Fakten vorkommenden Zahlen — die einzig erlaubten Zahlen im Text.
 * Enthält auch die deterministisch abgeleiteten ANZAHLEN (z. B. „2 Kennzahlen
 * außerhalb"), denn auch die stammen aus dieser Schicht, nicht aus der KI.
 */
export function erlaubteZahlen(f: Fakten): Set<number> {
  const s = new Set<number>();
  for (const k of f.kennzahlen) {
    for (const v of [k.ist, k.min, k.max, k.delta_eur_monat]) if (v != null) s.add(norm(v));
  }
  s.add(f.ausserhalb.length);
  s.add(f.kennzahlen.length);
  s.add(f.ruhig.length);
  s.add(f.nicht_bewertbar.length);
  return s;
}

/**
 * Zahlen aus einem deutschen Text ziehen (1.234,56 / 12,5 / 2026).
 * ISO-Daten werden vorher entfernt, sonst zerfiele '2026-07-30' in 2026/-7/-30.
 */
export function zahlenAusText(text: string): number[] {
  const ohneDatum = text.replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const treffer = ohneDatum.match(/-?\d+(?:\.\d{3})*(?:,\d+)?/g) ?? [];
  const raus: number[] = [];
  for (const t of treffer) {
    // deutsches Format: Punkt = Tausender, Komma = Dezimal
    const n = Number(t.replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(n)) raus.push(norm(n));
  }
  return raus;
}

export interface GuardrailErgebnis { ok: boolean; unbelegt: number[] }

/**
 * Guardrail: JEDE Zahl im KI-Text muss in den Fakten vorkommen. Jahreszahlen aus
 * dem Stichtag und die Zahl 0 sind zugelassen (0 = „keine"), sonst gilt: nicht
 * belegt ⇒ Befund verwerfen.
 */
export function pruefeText(text: string, f: Fakten): GuardrailErgebnis {
  const erlaubt = erlaubteZahlen(f);
  // Datumsbestandteile des Stichtags zulassen (z. B. 2026, 7, 30).
  for (const teil of f.stichtag.split("-")) {
    const n = Number(teil);
    if (Number.isFinite(n)) erlaubt.add(norm(n));
  }
  erlaubt.add(0);
  const unbelegt = zahlenAusText(text).filter((n) => !erlaubt.has(n));
  return { ok: unbelegt.length === 0, unbelegt: [...new Set(unbelegt)] };
}

function fmt(n: number | null, einheit: string): string {
  if (n == null) return "—";
  const s = n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  return einheit === "%" ? `${s} %` : einheit === "Tage" ? `${s} Tage` : s;
}

/** Deterministischer Befundtext — Fallback ohne KI (und Referenz für den Ton). */
export function deterministischerBefund(f: Fakten): { diagnose: string; text: string } {
  const draussen = f.ausserhalb;
  const diagnose = draussen.length === 0
    ? (f.kennzahlen.some((k) => k.status === "im_korridor")
      ? `${f.rolle_label}: alle bewertbaren Kennzahlen liegen im Korridor.`
      : `${f.rolle_label}: keine Kennzahl ist derzeit bewertbar.`)
    : `${f.rolle_label}: ${draussen.length} Kennzahl(en) außerhalb des Korridors.`;

  const zeilen: string[] = [];
  for (const k of draussen) {
    const seite = k.min != null && k.ist != null && k.ist < k.min ? "unter" : "über";
    const grenze = seite === "unter" ? k.min : k.max;
    const eur = k.delta_eur_monat != null ? ` Auswirkung: ${fmt(k.delta_eur_monat, "")} € pro Monat.` : "";
    zeilen.push(`${k.label}: ${fmt(k.ist, k.einheit)} — ${seite} Korridor (${fmt(grenze, k.einheit)}).${eur}`);
  }
  for (const r of f.ruhig) zeilen.push(r.text);
  if (f.nicht_bewertbar.length) zeilen.push(`Nicht bewertbar: ${f.nicht_bewertbar.join(", ")}.`);

  return { diagnose, text: [diagnose, ...zeilen].join("\n") + `\n\n${SIGNATUR}` };
}

/** Prompt für die KI. Enthält NUR die Fakten — die KI darf nichts hinzurechnen. */
export function baueSystemPrompt(): string {
  return [
    "Du formulierst den Befund für einen Amazon-Seller-Operator.",
    "REGELN, ausnahmslos:",
    "- Du RECHNEST NICHT. Verwende ausschließlich Zahlen, die in den Fakten stehen.",
    "- Erfinde keine Kennzahl, keinen Vergleich, keine Prognose.",
    "- Ton: nüchtern, direkt, Operator-Sprache. Keine Beschwichtigung, keine Ausrufezeichen, kein Marketing.",
    "- Aufbau: (1) EIN Satz Diagnose. (2) Was den Korridor verlässt, je Zeile mit Ist-Wert, Korridor und Euro-Auswirkung, sofern vorhanden. (3) Was auffällig ruhig ist.",
    "- Maximal 8 Zeilen. Kein Markdown, keine Aufzählungszeichen.",
    `- Beende den Text mit der Signatur ${SIGNATUR} in einer eigenen Zeile.`,
    "Antworte als JSON: {\"diagnose\": \"<ein Satz>\", \"text\": \"<der vollständige Befund>\"}",
  ].join("\n");
}

/** Nutzer-Prompt = die Fakten als kompaktes JSON. */
export function baueUserPrompt(f: Fakten): string {
  return JSON.stringify({
    produkt: f.produktname, asin: f.asin, rolle: f.rolle_label, stichtag: f.stichtag,
    ausserhalb: f.ausserhalb.map((k) => ({ kennzahl: k.label, ist: k.ist, min: k.min, max: k.max, einheit: k.einheit, euro_pro_monat: k.delta_eur_monat })),
    im_korridor: f.kennzahlen.filter((k) => k.status === "im_korridor").map((k) => ({ kennzahl: k.label, ist: k.ist, einheit: k.einheit })),
    auffaellig_ruhig: f.ruhig.map((r) => r.text),
    nicht_bewertbar: f.nicht_bewertbar,
  });
}

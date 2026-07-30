// massnahmen.ts — Schritt 4 des geführten Pfads: MASSNAHMEN.
//
// Brief-Regeln, die hier hart durchgesetzt werden:
//   * Maximal DREI offene Maßnahmen je ASIN. "Die Begrenzung ist das Produkt."
//   * Keine Empfehlung ohne Eurobetrag — wo der Effekt nicht berechenbar ist,
//     MUSS der Nutzer ihn beim Übernehmen selbst beziffern (wir erfinden nichts).
//   * Status offen / erledigt / verworfen; 'verworfen' nur MIT Grund.
//
// Alles hier ist rein und unit-getestet; DB-Zugriff liegt in massnahmen_lauf.ts.

export const MAX_OFFENE = 3;

export type MassnahmeStatus = "offen" | "erledigt" | "verworfen";

export interface MassnahmeVorschlag {
  kennzahl: string;
  text: string;
  /** Erwarteter Effekt EUR/Monat aus der deterministischen Schicht. null = muss beziffert werden. */
  effekt_eur: number | null;
}

/**
 * Konkrete Handlung je Kennzahl (qualitativ — KEINE Benchmark-Zahl im Code).
 * Formuliert als das, was der Operator tatsächlich anfasst.
 */
const HANDLUNG: Record<string, { zu_hoch: string; zu_niedrig: string }> = {
  tacos: {
    zu_hoch: "Werbeausgaben senken: Kampagnen mit dem schlechtesten Verhältnis pausieren, Gebote der Verlust-Keywords reduzieren.",
    zu_niedrig: "Werbebudget erhöhen: bei den Keywords mit der besten Conversion nachlegen, solange der Korridor hält.",
  },
  acos: {
    zu_hoch: "Keywords mit hohem Spend ohne Verkauf negativ setzen; Gebote der teuersten Suchbegriffe schrittweise senken.",
    zu_niedrig: "Gebote bei profitablen Keywords anheben und Suchbegriff-Bericht auf neue Kandidaten prüfen.",
  },
  cvr: {
    zu_niedrig: "Listing prüfen: Hauptbild, erste zwei Bullets und Preis gegen die drei Wettbewerber im Suchergebnis stellen.",
    zu_hoch: "Conversion ist stark — Reichweite ausbauen (Budget/Keywords), statt am Listing zu ändern.",
  },
  deckungsbeitrag_nach_werbung: {
    zu_niedrig: "Marge heben: Werbekosten je Einheit senken oder Preis anheben; Einkaufs- und Versandkosten gegenprüfen.",
    zu_hoch: "Spielraum vorhanden — Preis oder Werbedruck testen, um Volumen zu kaufen.",
  },
  bestandsreichweite: {
    zu_niedrig: "Nachschub anstoßen: Nachbestellung auslösen und Werbedruck bis zum Wareneingang drosseln.",
    zu_hoch: "Kapital gebunden: Abverkauf beschleunigen (Preis/Werbung) oder Nachbestellung verschieben.",
  },
};

/**
 * Leitet Maßnahmen-Vorschläge aus den Fakten ab — deterministisch, nach
 * finanzieller Auswirkung sortiert, auf MAX_OFFENE gekürzt.
 */
export function schlageMassnahmenVor(fakten: {
  ausserhalb?: Array<{ kennzahl: string; label: string; ist: number | null; min: number | null; max: number | null; delta_eur_monat: number | null }>;
}): MassnahmeVorschlag[] {
  const draussen = fakten.ausserhalb ?? [];
  const sortiert = [...draussen].sort((a, b) => (b.delta_eur_monat ?? -1) - (a.delta_eur_monat ?? -1));
  const raus: MassnahmeVorschlag[] = [];
  for (const k of sortiert) {
    const h = HANDLUNG[k.kennzahl];
    if (!h) continue;
    const zuHoch = k.max != null && k.ist != null && k.ist > k.max;
    raus.push({
      kennzahl: k.kennzahl,
      text: zuHoch ? h.zu_hoch : h.zu_niedrig,
      effekt_eur: k.delta_eur_monat,
    });
    if (raus.length >= MAX_OFFENE) break;
  }
  return raus;
}

/** Validiert eine zu speichernde Maßnahme. Wirft mit klarer Meldung. */
export function pruefeMassnahme(p: { text?: unknown; effekt_eur?: unknown }, offeneVorhanden: number): { text: string; effekt_eur: number } {
  const text = String(p.text ?? "").trim();
  if (text.length < 5) throw new Error("Maßnahme braucht eine konkrete Handlung.");
  const eur = Number(p.effekt_eur);
  if (p.effekt_eur === null || p.effekt_eur === undefined || p.effekt_eur === "" || !Number.isFinite(eur)) {
    throw new Error("Erwarteter Effekt in Euro pro Monat fehlt — ohne Betrag keine Maßnahme.");
  }
  if (offeneVorhanden >= MAX_OFFENE) {
    throw new Error(`Maximal ${MAX_OFFENE} offene Maßnahmen je Produkt. Zuerst eine erledigen oder verwerfen.`);
  }
  return { text, effekt_eur: Math.round(eur * 100) / 100 };
}

export interface StatusWechsel {
  status: MassnahmeStatus;
  grund: string | null;
  erledigt_am: string | null;
}

/** Validiert einen Statuswechsel. `jetzt` wird hereingereicht (deterministisch). */
export function pruefeStatusWechsel(status: unknown, grund: unknown, jetzt: string): StatusWechsel {
  const s = String(status ?? "");
  if (s !== "offen" && s !== "erledigt" && s !== "verworfen") throw new Error("Unbekannter Status.");
  if (s === "verworfen") {
    const g = String(grund ?? "").trim();
    if (g.length < 3) throw new Error("Verwerfen nur mit Grund.");
    return { status: s, grund: g, erledigt_am: null };
  }
  if (s === "erledigt") return { status: s, grund: null, erledigt_am: jetzt };
  return { status: "offen", grund: null, erledigt_am: null }; // Wiedereröffnen räumt auf
}

/** Summe der erwarteten Effekte (für die Wiedervorlage: „erwartet +X €/Monat"). */
export function summeEffekt(massnahmen: Array<{ effekt_eur: number | null }>): number {
  return Math.round(massnahmen.reduce((s, m) => s + (Number(m.effekt_eur) || 0), 0) * 100) / 100;
}

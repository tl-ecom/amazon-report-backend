// =============================================================================
// Strategie-Definitionen (Korridore) — SEED-DATEI
// =============================================================================
// DU füllst hier die Werte. Der Code erfindet KEINE Benchmarks.
//
// Diese Datei ist die kanonische Quelle für die Rollen-Korridore. Sie wird
// (Schritt 3) in die DB-Tabelle `strategie_definitionen` gespiegelt, und die
// reine Rule Engine (Schritt 2) bekommt die Definitionen als Parameter herein-
// gereicht — die Engine liest also nie selbst aus Netzwerk/DB.
//
// Solange leading_kpi = null ODER der Korridor leer ist, gilt die Rolle als
// "nicht konfiguriert": die Engine meldet dafür NICHTS (Ergebnis
// 'nicht_bewertbar'), statt gegen erfundene Zahlen zu prüfen.
// -----------------------------------------------------------------------------

/** Erlaubte Kennzahlen. Muss mit dem DB-Domain `strategie_kennzahl` übereinstimmen.
 *  Rank ist bewusst NICHT dabei (keine Datenquelle angebunden). */
export type Kennzahl =
  | "acos"                     // Advertising Cost of Sale (%)
  | "tacos"                    // Total ACoS (%)
  | "umsatz"                   // Umsatz im Zeitraum
  | "einheiten"                // verkaufte Einheiten
  | "cvr"                      // Conversion Rate (%)
  | "deckungsbeitrag_stueck"   // DB pro Einheit (Umsatz − EK − Gebühren)
  | "bestandsreichweite"       // Tage Reichweite (Achtung: bei FBA oft unbekannt)
  | "umsatzanteil_portfolio";  // Anteil dieser ASIN am Portfolio-Umsatz (%)

export type Rolle = "launch" | "scale" | "hold" | "harvest" | "exit";

export interface Korridor {
  /** Untergrenze in Einheit der leading_kpi. null = keine Untergrenze. */
  min: number | null;
  /** Obergrenze. null = keine Obergrenze (einseitiger Korridor). */
  max: number | null;
}

export interface AlertRegel {
  /** Kennzahl, die den Alarm auslöst. Default in der Engine: die leading_kpi. */
  kennzahl: Kennzahl;
  /** 'unter'/'ueber' = einseitig gegen `schwelle`; 'ausserhalb' = gegen den Korridor. */
  richtung: "unter" | "ueber" | "ausserhalb";
  /** Schwellenwert für 'unter'/'ueber'. Bei 'ausserhalb' ignoriert (Korridor gilt). */
  schwelle?: number;
  severity: "hoch" | "mittel" | "niedrig";
  /** "Erster Ort zum Suchen", wenn diese Regel feuert (Ursachen-Hinweis). */
  erster_ort_zum_suchen: string;
}

export interface StrategieDefinition {
  rolle: Rolle;
  /** Die EINE entscheidende Kennzahl. null = noch nicht konfiguriert. */
  leading_kpi: Kennzahl | null;
  korridor: Korridor;
  /** Was Alarm auslöst. Leer = nur der Korridor der leading_kpi wird geprüft. */
  alert_regeln: AlertRegel[];
  /** Kennzahlen, die bei dieser Rolle NIE gemeldet werden — auch bei starker Abweichung. */
  muted_metrics: Kennzahl[];
  /** Nach Ablauf ist eine Rollen-Entscheidung fällig. null = keine Frist. */
  max_dauer_tage: number | null;
  /** Kurzbeschreibung der Rolle (qualitativ, keine Benchmark-Zahl). */
  beschreibung: string;
}

// -----------------------------------------------------------------------------
// LEER vorbelegt. Trage leading_kpi, korridor, alert_regeln, muted_metrics und
// max_dauer_tage je Rolle ein. Beispielhinweis (NICHT als Vorgabe gemeint):
//   60 % ACoS ist im Launch normal, beim Harvest ein Notfall — also andere
//   Korridore/leading_kpi je Rolle.
// -----------------------------------------------------------------------------
export const STRATEGIE_DEFINITIONEN: Record<Rolle, StrategieDefinition> = {
  launch: {
    rolle: "launch",
    leading_kpi: null,
    korridor: { min: null, max: null },
    alert_regeln: [],
    muted_metrics: [],
    max_dauer_tage: null,
    beschreibung: "Neueinführung — Sichtbarkeit/Rank aufbauen; Anlaufverluste bewusst.",
  },
  scale: {
    rolle: "scale",
    leading_kpi: null,
    korridor: { min: null, max: null },
    alert_regeln: [],
    muted_metrics: [],
    max_dauer_tage: null,
    beschreibung: "Wachstum — profitabel skalieren, Volumen ausbauen.",
  },
  hold: {
    rolle: "hold",
    leading_kpi: null,
    korridor: { min: null, max: null },
    alert_regeln: [],
    muted_metrics: [],
    max_dauer_tage: null,
    beschreibung: "Halten — stabile Position/Cashcow verteidigen.",
  },
  harvest: {
    rolle: "harvest",
    leading_kpi: null,
    korridor: { min: null, max: null },
    alert_regeln: [],
    muted_metrics: [],
    max_dauer_tage: null,
    beschreibung: "Ernten — Marge maximieren, Ausgaben zurückfahren.",
  },
  exit: {
    rolle: "exit",
    leading_kpi: null,
    korridor: { min: null, max: null },
    alert_regeln: [],
    muted_metrics: [],
    max_dauer_tage: null,
    beschreibung: "Auslauf — Restbestand abverkaufen, Ressourcen abziehen.",
  },
};

// -----------------------------------------------------------------------------
// Schwellen für die VORSCHLAGS-Logik (Regel-Engine, deterministisch).
// Auch das sind Benchmarks — DU füllst sie. Solange ein für eine Regel nötiger
// Wert null ist, greift die Regel nicht; fehlen die zentralen Signale, gibt die
// Engine eine OFFENE FRAGE (low confidence) aus statt still zuzuweisen.
// -----------------------------------------------------------------------------
export interface VorschlagSchwellen {
  /** Jünger als X Wochen ⇒ launch-Kandidat. */
  launch_max_alter_wochen: number | null;
  /** Ab X Wochen gilt ein Produkt als „reif" (hold/harvest/exit statt launch). */
  reif_ab_wochen: number | null;
  /** Umsatztrend ≥ X (relativ, z. B. 0.2 = +20 %) ⇒ Wachstum (scale-Kandidat). */
  scale_min_umsatz_trend: number | null;
  /** Umsatztrend ≤ X (relativ, negativ) ⇒ Rückgang (harvest/exit-Kandidat). */
  schrumpf_umsatz_trend: number | null;
  /** Bestandsreichweite ≥ X Tage nötig, um skalieren zu empfehlen. */
  scale_min_reichweite_tage: number | null;
  /** Deckungsbeitrag/Stück gilt ab diesem Wert als profitabel (i. d. R. 0). */
  db_stueck_positiv_ab: number | null;
}

export const VORSCHLAG_SCHWELLEN: VorschlagSchwellen = {
  launch_max_alter_wochen: null,
  reif_ab_wochen: null,
  scale_min_umsatz_trend: null,
  schrumpf_umsatz_trend: null,
  scale_min_reichweite_tage: null,
  db_stueck_positiv_ab: null,
};

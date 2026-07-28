// strategie.ts — Rule Engine für den Strategie-Layer (Schritt 2). REINE Funktionen,
// KEIN Netzwerk-/DB-Zugriff: Definitionen und Snapshots kommen als Parameter herein,
// Findings gehen als Rückgabe hinaus. Genau diese Grenze ist gewollt — falls später
// ein LLM dazukommt, formuliert es nur fertige Findings aus, es entscheidet nie.
//
// Zwei Kernfunktionen:
//   * vorschlagRolle(snapshot, schwellen)         → Rollen-Vorschlag + Confidence
//   * evaluate(snapshot, aktiveStrategie, def, …) → Findings (max. 3) + Beobachtung
//
// Ehrlichkeit (wie im Rest des Codes):
//   * fehlender Wert = null = UNBEKANNT, niemals 0. Unbekannt ⇒ nicht bewertbar,
//     kein erfundenes Finding.
//   * keine Benchmark-ZAHL steht hier im Code — alle Schwellen/Korridore kommen
//     aus config/strategy-definitions.ts (vom Coach gefüllt).

import type {
  AlertRegel,
  Kennzahl,
  Korridor,
  Rolle,
  StrategieDefinition,
  VorschlagSchwellen,
} from "../../../config/strategy-definitions.ts";

// --- Eingabeformat (dokumentiert; Amazon-Anbindung ist NICHT Teil dieser Aufgabe) ---

/**
 * Ein ASIN-Snapshot = die verdichteten Kennzahlen einer ASIN am Ende eines
 * Beobachtungszeitraums. Kennzahlwerte sind `number | null` (null = unbekannt).
 * Zusatzsignale (erstmals_gesehen, umsatz_trend) speisen die Vorschlagslogik.
 */
export interface AsinSnapshot {
  asin: string;
  /** Stichtag (Ende Zeitraum), 'YYYY-MM-DD'. */
  stichtag: string;
  /** Kennzahlwerte. Nicht enthaltene/`null` = unbekannt. */
  kennzahlen: Partial<Record<Kennzahl, number | null>>;
  /** Produktalter-Quelle (asins.erstmals_gesehen), 'YYYY-MM-DD' oder null. */
  erstmals_gesehen: string | null;
  /** Preisklasse (frei, z. B. '10-20€') — nur für die Beobachtung, nicht bewertet. */
  preisklasse?: string | null;
  /** Umsatztrend ggü. Vorperiode, relativ (0.15 = +15 %). null = unbekannt. */
  umsatz_trend?: number | null;
}

/** Aktive Zuordnung, wie sie in asin_strategien steht (nur die für evaluate nötigen Felder). */
export interface AktiveStrategie {
  rolle: Rolle;
  /** Beginn der aktiven Rolle, 'YYYY-MM-DD' (asin_strategien.gueltig_ab). */
  gueltig_ab: string;
  /** Review-Fälligkeit, 'YYYY-MM-DD' oder null. */
  review_faellig: string | null;
}

// --- Ausgabeformate ---

export type Konfidenz = "high" | "medium" | "low";

export interface Vorschlag {
  rolle: Rolle;
  konfidenz: Konfidenz;
  /** Ein Satz. */
  begruendung: string;
  /** Die Felder, auf denen der Vorschlag beruht. */
  basis: Record<string, number | null>;
  /** true bei low confidence ⇒ NICHT still zuweisen, als offene Frage ausgeben. */
  offene_frage: boolean;
}

export type Severity = "hoch" | "mittel" | "niedrig";

export interface Finding {
  /** Betroffene Kennzahl, oder 'review' für ein Entscheidungs-fällig-Ereignis. */
  kennzahl: Kennzahl | "review";
  severity: Severity;
  /** Istwert der Kennzahl (null bei 'review'). */
  ist_wert: number | null;
  /** Menschenlesbare Abweichung. */
  abweichung: string;
  /** Betrag der Abweichung — nur fürs Priorisieren (größer = weiter draußen). */
  magnitude: number;
  /** „Erster Ort zum Suchen" — Ursachen-Hinweis aus der Regeldefinition. */
  erster_ort_zum_suchen: string;
  /** 1-basierter Rang nach Priorisierung. */
  rang: number;
}

export type KorridorErgebnis = "im_korridor" | "ausserhalb" | "nicht_bewertbar";

export interface KorridorBeobachtung {
  rolle: Rolle;
  beobachtet_am: string;
  leading_kpi: Kennzahl | null;
  leading_wert: number | null;
  kennzahlen: Partial<Record<Kennzahl, number | null>>;
  preisklasse: string | null;
  wochen_seit_launch: number | null;
  ergebnis: KorridorErgebnis;
}

export interface EvaluateErgebnis {
  /** Priorisiert, auf max. 3 gekürzt. */
  findings: Finding[];
  /** Wie viele Findings VOR dem Kürzen — Kürzen ist Feature, aber nicht still. */
  findings_gesamt: number;
  /** Explizit true, wenn im Korridor und nichts zu melden. */
  kein_handlungsbedarf: boolean;
  /** Gesetzt, wenn nicht bewertbar (Strategie unvollständig / Kennzahl unbekannt). */
  hinweis?: string;
  /** Datensatz für korridor_beobachtungen. */
  beobachtung: KorridorBeobachtung;
}

// --- kleine reine Helfer ---

const MS_PRO_TAG = 86_400_000;

/** Ganze Wochen zwischen zwei 'YYYY-MM-DD'; null wenn ein Datum fehlt/unlesbar. */
export function wochenSeit(von: string | null, bis: string): number | null {
  if (!von) return null;
  const a = Date.parse(von);
  const b = Date.parse(bis);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / MS_PRO_TAG / 7);
}

/** Ganze Tage zwischen zwei 'YYYY-MM-DD' (bis − von); null wenn unlesbar. */
function tageSeit(von: string | null, bis: string): number | null {
  if (!von) return null;
  const a = Date.parse(von);
  const b = Date.parse(bis);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / MS_PRO_TAG);
}

/** Auf welcher Seite verlässt der Wert den Korridor? null = drin (oder Seite offen). */
function korridorBruch(wert: number, k: Korridor): "unter" | "ueber" | null {
  if (k.min != null && wert < k.min) return "unter";
  if (k.max != null && wert > k.max) return "ueber";
  return null;
}

/** Relativer Abstand außerhalb des Korridors (fürs Sortieren). */
function bruchMagnitude(wert: number, k: Korridor, seite: "unter" | "ueber"): number {
  const grenze = seite === "unter" ? k.min! : k.max!;
  const nenner = Math.abs(grenze) || 1;
  return Math.abs(wert - grenze) / nenner;
}

function definitionUnvollstaendig(def: StrategieDefinition): boolean {
  return def.leading_kpi == null || (def.korridor.min == null && def.korridor.max == null);
}

// --- Vorschlagslogik (deterministisch, regelbasiert) ---

const SATZ: Record<Rolle, string> = {
  launch: "Junges Produkt in der Anlaufphase — Sichtbarkeit priorisieren.",
  scale: "Wächst und ist profitabel mit ausreichend Bestand — skalieren.",
  hold: "Reif, stabil und profitabel — Position halten.",
  harvest: "Rückläufig, aber noch profitabel — Marge ernten.",
  exit: "Unprofitabel und rückläufig — Auslauf prüfen.",
};

/**
 * Schlägt eine Rolle vor. Deterministisch, erste passende Regel gewinnt.
 * Confidence rein aus DATENVOLLSTÄNDIGKEIT der zentralen Signale (Alter, Umsatz-
 * trend, DB/Stück) — fehlen die zentralen Signale, ist es eine offene Frage.
 */
export function vorschlagRolle(snap: AsinSnapshot, schwellen: VorschlagSchwellen): Vorschlag {
  const alter = wochenSeit(snap.erstmals_gesehen, snap.stichtag);
  const trend = snap.umsatz_trend ?? null;
  const db = snap.kennzahlen.deckungsbeitrag_stueck ?? null;
  const reichweite = snap.kennzahlen.bestandsreichweite ?? null;
  const anteil = snap.kennzahlen.umsatzanteil_portfolio ?? null;

  const basis: Record<string, number | null> = {
    alter_wochen: alter,
    umsatz_trend: trend,
    deckungsbeitrag_stueck: db,
    bestandsreichweite: reichweite,
    umsatzanteil_portfolio: anteil,
  };

  // Schwellen für die Kernregeln nicht konfiguriert ⇒ nicht raten.
  const kernSchwellenFehlen =
    schwellen.launch_max_alter_wochen == null &&
    schwellen.scale_min_umsatz_trend == null &&
    schwellen.schrumpf_umsatz_trend == null;
  if (kernSchwellenFehlen) {
    return { rolle: "hold", konfidenz: "low", begruendung: "Vorschlags-Schwellen sind noch nicht konfiguriert.", basis, offene_frage: true };
  }

  // Zentrale Signale fehlen ⇒ offene Frage, nicht still zuweisen.
  if (alter == null && trend == null) {
    return { rolle: "hold", konfidenz: "low", begruendung: "Zu wenig Signal: Produktalter und Umsatztrend sind unbekannt.", basis, offene_frage: true };
  }

  const dbGrenze = schwellen.db_stueck_positiv_ab ?? 0;
  const profitabel = db == null ? null : db > dbGrenze;

  let rolle: Rolle;
  if (alter != null && schwellen.launch_max_alter_wochen != null && alter < schwellen.launch_max_alter_wochen) {
    rolle = "launch";
  } else if (
    profitabel === false && trend != null && schwellen.schrumpf_umsatz_trend != null &&
    trend <= schwellen.schrumpf_umsatz_trend
  ) {
    rolle = "exit"; // unprofitabel UND rückläufig
  } else if (
    trend != null && schwellen.scale_min_umsatz_trend != null && trend >= schwellen.scale_min_umsatz_trend &&
    profitabel !== false && // profitabel oder unbekannt (Bestand darf fehlen — FBA)
    (reichweite == null || schwellen.scale_min_reichweite_tage == null || reichweite >= schwellen.scale_min_reichweite_tage)
  ) {
    rolle = "scale"; // wächst, (mind.) nicht unprofitabel, genug Bestand
  } else if (
    trend != null && schwellen.schrumpf_umsatz_trend != null && trend <= schwellen.schrumpf_umsatz_trend &&
    profitabel === true
  ) {
    rolle = "harvest"; // rückläufig, aber profitabel
  } else {
    rolle = "hold"; // reif, stabil, profitabel — Default
  }

  const bekannt = [alter, trend, db].filter((x) => x != null).length;
  const konfidenz: Konfidenz = bekannt === 3 ? "high" : bekannt === 2 ? "medium" : "low";

  return { rolle, konfidenz, begruendung: SATZ[rolle], basis, offene_frage: konfidenz === "low" };
}

// --- Auswertung gegen den Korridor der AKTIVEN Rolle ---

/** Prüft eine Zusatz-Alertregel gegen den Snapshot. null = kein Alarm/unbekannt. */
function pruefeRegel(regel: AlertRegel, snap: AsinSnapshot, korridor: Korridor): Finding | null {
  const wert = snap.kennzahlen[regel.kennzahl] ?? null;
  if (wert == null) return null; // unbekannt ⇒ kein erfundenes Finding

  let getroffen = false;
  let magnitude = 0;
  let abweichung = "";

  if (regel.richtung === "ausserhalb") {
    const seite = korridorBruch(wert, korridor);
    if (seite) {
      getroffen = true;
      magnitude = bruchMagnitude(wert, korridor, seite);
      abweichung = `${regel.kennzahl}=${wert} ${seite === "unter" ? "unter" : "über"} Korridor`;
    }
  } else if (regel.schwelle != null) {
    if (regel.richtung === "unter" && wert < regel.schwelle) {
      getroffen = true;
      magnitude = Math.abs(wert - regel.schwelle) / (Math.abs(regel.schwelle) || 1);
      abweichung = `${regel.kennzahl}=${wert} < ${regel.schwelle}`;
    } else if (regel.richtung === "ueber" && wert > regel.schwelle) {
      getroffen = true;
      magnitude = Math.abs(wert - regel.schwelle) / (Math.abs(regel.schwelle) || 1);
      abweichung = `${regel.kennzahl}=${wert} > ${regel.schwelle}`;
    }
  }

  if (!getroffen) return null;
  return {
    kennzahl: regel.kennzahl,
    severity: regel.severity,
    ist_wert: wert,
    abweichung,
    magnitude,
    erster_ort_zum_suchen: regel.erster_ort_zum_suchen,
    rang: 0,
  };
}

const SEV_RANG: Record<Severity, number> = { hoch: 0, mittel: 1, niedrig: 2 };

/**
 * Priorisierung der Findings — bewusst in dieser Reihenfolge:
 *   1. Entscheidungs-erzwingende Ereignisse ('review') zuerst: sie blockieren
 *      die Rolle selbst, alles andere ist nachrangig, solange das offen ist.
 *   2. Schweregrad (hoch vor mittel vor niedrig).
 *   3. Abweichungsgröße (weiter draußen zuerst).
 * So zeigt die auf 3 gekürzte Wochenausgabe zuerst, was am ehesten Handeln erzwingt.
 */
function priorisiere(findings: Finding[]): Finding[] {
  const sortiert = [...findings].sort((a, b) => {
    const ra = a.kennzahl === "review" ? 0 : 1;
    const rb = b.kennzahl === "review" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (SEV_RANG[a.severity] !== SEV_RANG[b.severity]) return SEV_RANG[a.severity] - SEV_RANG[b.severity];
    return b.magnitude - a.magnitude;
  });
  sortiert.forEach((f, i) => (f.rang = i + 1));
  return sortiert;
}

/**
 * Wertet eine ASIN gegen den Korridor ihrer AKTIVEN Rolle aus.
 * `heute` ('YYYY-MM-DD') wird hereingereicht, damit die Funktion deterministisch bleibt.
 */
export function evaluate(
  snap: AsinSnapshot,
  aktiv: AktiveStrategie,
  def: StrategieDefinition,
  heute: string,
  max_dauer_tage: number | null = null,
): EvaluateErgebnis {
  const findings: Finding[] = [];
  const wochenSeitLaunch = wochenSeit(snap.erstmals_gesehen, snap.stichtag);
  const leadWert = def.leading_kpi ? (snap.kennzahlen[def.leading_kpi] ?? null) : null;

  // 1) Review / Entscheidung fällig — eigenes meldepflichtiges Ereignis.
  const reviewTage = tageSeit(aktiv.review_faellig, heute);
  const dauerTage = tageSeit(aktiv.gueltig_ab, heute);
  const reviewFaellig = reviewTage != null && reviewTage >= 0;
  const dauerAbgelaufen = max_dauer_tage != null && dauerTage != null && dauerTage >= max_dauer_tage;
  if (reviewFaellig || dauerAbgelaufen) {
    const seit = reviewFaellig ? reviewTage! : (dauerTage ?? 0);
    const wochenText = wochenSeitLaunch != null ? `${wochenSeitLaunch} Wo. ` : "";
    findings.push({
      kennzahl: "review",
      severity: "mittel",
      ist_wert: null,
      abweichung: `Rolle „${aktiv.rolle}" ${wochenText}aktiv — Entscheidung fällig${reviewFaellig ? ` (seit ${seit} T)` : ""}.`,
      magnitude: seit,
      erster_ort_zum_suchen: "Rollen-Review: bewusst verlängern oder wechseln (z. B. Scale ↔ Exit).",
      rang: 0,
    });
  }

  // 2) Korridor der leading_kpi.
  let ergebnis: KorridorErgebnis;
  let hinweis: string | undefined;

  if (definitionUnvollstaendig(def)) {
    ergebnis = "nicht_bewertbar";
    hinweis = `Strategie „${aktiv.rolle}" ist unvollständig konfiguriert (leading_kpi/Korridor fehlen).`;
  } else if (leadWert == null) {
    ergebnis = "nicht_bewertbar";
    hinweis = `Kennzahl „${def.leading_kpi}" ist unbekannt — nicht bewertbar.`;
  } else {
    const seite = korridorBruch(leadWert, def.korridor);
    if (seite) {
      ergebnis = "ausserhalb";
      const regelFuerLead = def.alert_regeln.find((r) => r.kennzahl === def.leading_kpi && r.richtung === "ausserhalb");
      findings.push({
        kennzahl: def.leading_kpi!,
        severity: regelFuerLead?.severity ?? "mittel",
        ist_wert: leadWert,
        abweichung: `${def.leading_kpi}=${leadWert} ${seite === "unter" ? "unter" : "über"} Korridor [${def.korridor.min ?? "–"}, ${def.korridor.max ?? "–"}]`,
        magnitude: bruchMagnitude(leadWert, def.korridor, seite),
        erster_ort_zum_suchen: regelFuerLead?.erster_ort_zum_suchen ?? "Führende Kennzahl außerhalb des Zielkorridors.",
        rang: 0,
      });
    } else {
      ergebnis = "im_korridor";
    }

    // Zusatz-Alertregeln (leading schon oben behandelt).
    for (const regel of def.alert_regeln) {
      if (regel.kennzahl === def.leading_kpi && regel.richtung === "ausserhalb") continue;
      const f = pruefeRegel(regel, snap, def.korridor);
      if (f) findings.push(f);
    }
  }

  // 3) muted_metrics verwerfen — auch bei starker Abweichung. 'review' bleibt immer.
  const gefiltert = findings.filter(
    (f) => f.kennzahl === "review" || !def.muted_metrics.includes(f.kennzahl as Kennzahl),
  );

  // 4) Priorisieren + auf 3 kürzen (Kürzen ist Feature; findings_gesamt bleibt sichtbar).
  const sortiert = priorisiere(gefiltert);
  const top = sortiert.slice(0, 3);

  const beobachtung: KorridorBeobachtung = {
    rolle: aktiv.rolle,
    beobachtet_am: snap.stichtag,
    leading_kpi: def.leading_kpi ?? null,
    leading_wert: leadWert,
    kennzahlen: snap.kennzahlen,
    preisklasse: snap.preisklasse ?? null,
    wochen_seit_launch: wochenSeitLaunch,
    ergebnis,
  };

  return {
    findings: top,
    findings_gesamt: sortiert.length,
    kein_handlungsbedarf: ergebnis === "im_korridor" && top.length === 0,
    hinweis,
    beobachtung,
  };
}

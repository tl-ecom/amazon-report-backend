// steuerbarkeit.ts — Modul 1 des Fee Decoders: steuerbar vs. nicht steuerbar.
//
// Kernaussage laut Spezifikation: nicht „12,40 € Gebühren", sondern
// „3,10 € davon selbst erzeugt — Hebel: Operations".
//
// Die Klassifizierung kommt aus der Mapping-Tabelle fee_type_classification,
// bewusst NICHT aus einem switch: Amazon führt laufend neue Gebührentypen ein.
// Unbekannte Typen laufen in einen eigenen Topf und erzeugen einen Hinweis,
// statt still in „nicht steuerbar" zu verschwinden — das wäre eine falsche
// Entwarnung: „nichts selbst verursacht", weil wir es nicht kennen.
//
// Der Hebel ordnet ins Coaching-Modell ein. Er steuert NICHTS: Der
// Maßnahmentext hängt am Gebührentyp, nicht am Hebel.

export interface Position {
  fee_typ: string;
  /** Signiert wie gebucht: negativ = Kosten. */
  betrag_cents: number;
  quelle: "abrechnung" | "lager";
  /**
   * Steckt in diesem Betrag noch Umsatzsteuer? Gebuchte Abrechnungsbetraege: ja.
   * Werte aus dem Lagerbericht sind Rate-Card-Zahlen und bereits netto — sie
   * noch einmal zu teilen wuerde die Steuer zweimal herausrechnen.
   * Standard true, damit ein vergessenes Feld eher zu hohe als zu niedrige
   * Kosten zeigt.
   */
  ust_enthalten?: boolean;
}

export interface Klassifizierung {
  fee_typ: string;
  label: string | null;
  /** null = noch nicht eingeordnet. Bewusst dreiwertig. */
  steuerbar: boolean | null;
  hebel: string | null;
  hebel_alternativ: string | null;
  massnahme: string | null;
}

export interface TypZeile {
  fee_typ: string;
  label: string;
  betrag: number;
  steuerbar: boolean | null;
  hebel: string | null;
  /** Zweiter möglicher Hebel — dann ist es eine Hypothese, keine Zuordnung. */
  hebel_alternativ: string | null;
  massnahme: string | null;
  quellen: string[];
}

export interface HebelZeile {
  hebel: string;
  betrag: number;
  typen: string[];
  /** true = mindestens ein Typ ist nur hypothetisch zugeordnet. */
  hypothese: boolean;
}

export interface Modul1Ergebnis {
  gesamt: number;
  nicht_steuerbar: number;
  steuerbar: number;
  unklassifiziert: number;
  /** Anteil steuerbar am KLASSIFIZIERTEN Teil. null, wenn nichts klassifiziert ist. */
  anteil_steuerbar: number | null;
  je_typ: TypZeile[];
  je_hebel: HebelZeile[];
  /** Typen ohne Einordnung — Arbeitsliste, kein stiller Rest. */
  offene_typen: Array<{ fee_typ: string; betrag: number }>;
  kernaussage: string;
  /** Wie belastbar ist die Aussage? Viel Unklassifiziertes macht sie wackelig. */
  belastbar: boolean;
  hinweis: string | null;
}

/** Ab diesem Anteil Unklassifiziertem ist die Kernaussage nicht mehr belastbar. */
export const MAX_UNKLASSIFIZIERT = 0.1;

const HEBEL_LABEL: Record<string, string> = {
  produkt_market_fit: "Produkt-Market-Fit",
  content: "Content",
  ppc: "PPC",
  social_trust: "Social Trust / Bewertungen",
  operations: "Operations / Supply Chain / Zahlen beherrschen",
};

export function hebelLabel(h: string): string {
  return HEBEL_LABEL[h] ?? h;
}

function eur(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Fasst Gebührenpositionen zusammen und trennt selbst verursachte von
 * unvermeidbaren. `ustFaktor` rechnet die enthaltene Umsatzsteuer heraus
 * (1 = nichts herausrechnen) — sie ist bei Vorsteuerabzug kein Kosten.
 */
export function analysiereSteuerbarkeit(
  positionen: Position[],
  klassifizierung: Klassifizierung[],
  ustFaktor = 1,
): Modul1Ergebnis {
  const teiler = Number.isFinite(ustFaktor) && ustFaktor >= 1 ? ustFaktor : 1;
  const karte = new Map(klassifizierung.map((k) => [k.fee_typ, k]));

  // Je Typ aufsummieren. Beträge als KOSTEN (positiv) führen, damit Summen und
  // Anteile lesbar bleiben; Gutschriften mindern entsprechend.
  const proTyp = new Map<string, { betrag: number; quellen: Set<string> }>();
  for (const p of positionen) {
    const typ = String(p.fee_typ ?? "").trim() || "Unbekannt";
    const eintrag = proTyp.get(typ) ?? { betrag: 0, quellen: new Set<string>() };
    const teilen = p.ust_enthalten === false ? 1 : teiler;
    eintrag.betrag += -p.betrag_cents / teilen; // negativ gebucht -> positive Kosten
    eintrag.quellen.add(p.quelle);
    proTyp.set(typ, eintrag);
  }

  const je_typ: TypZeile[] = [...proTyp.entries()].map(([fee_typ, v]) => {
    const k = karte.get(fee_typ);
    return {
      fee_typ,
      label: k?.label ?? fee_typ,
      betrag: eur(v.betrag),
      steuerbar: k?.steuerbar ?? null,
      hebel: k?.hebel ?? null,
      hebel_alternativ: k?.hebel_alternativ ?? null,
      massnahme: k?.massnahme ?? null,
      quellen: [...v.quellen].sort(),
    };
  }).sort((a, b) => b.betrag - a.betrag);

  const summe = (f: (z: TypZeile) => boolean) =>
    Math.round(je_typ.filter(f).reduce((s, z) => s + z.betrag, 0) * 100) / 100;

  const nicht_steuerbar = summe((z) => z.steuerbar === false);
  const steuerbar = summe((z) => z.steuerbar === true);
  const unklassifiziert = summe((z) => z.steuerbar === null);
  const gesamt = Math.round((nicht_steuerbar + steuerbar + unklassifiziert) * 100) / 100;

  // Je Hebel — nur steuerbare Typen. Ein Typ mit zwei möglichen Hebeln zählt
  // auf BEIDE, wird aber als Hypothese markiert: Wir wissen es nicht, und so
  // zu tun als ob wäre schlimmer als die Doppelnennung.
  const proHebel = new Map<string, { betrag: number; typen: string[]; hypothese: boolean }>();
  for (const z of je_typ) {
    if (z.steuerbar !== true) continue;
    const hebel = [z.hebel, z.hebel_alternativ].filter((h): h is string => Boolean(h));
    const istHypothese = hebel.length > 1;
    for (const h of hebel) {
      const e = proHebel.get(h) ?? { betrag: 0, typen: [], hypothese: false };
      e.betrag += z.betrag;
      e.typen.push(z.label);
      e.hypothese = e.hypothese || istHypothese;
      proHebel.set(h, e);
    }
  }
  const je_hebel: HebelZeile[] = [...proHebel.entries()]
    .map(([hebel, v]) => ({
      hebel, betrag: Math.round(v.betrag * 100) / 100,
      typen: v.typen, hypothese: v.hypothese,
    }))
    .sort((a, b) => b.betrag - a.betrag);

  const klassifiziert = nicht_steuerbar + steuerbar;
  const anteil_steuerbar = klassifiziert > 0
    ? Math.round((steuerbar / klassifiziert) * 1000) / 10
    : null;

  const anteilOffen = gesamt > 0 ? unklassifiziert / gesamt : 0;
  const belastbar = gesamt > 0 && anteilOffen <= MAX_UNKLASSIFIZIERT;

  const offene_typen = je_typ
    .filter((z) => z.steuerbar === null && z.betrag !== 0)
    .map((z) => ({ fee_typ: z.fee_typ, betrag: z.betrag }));

  return {
    gesamt, nicht_steuerbar, steuerbar, unklassifiziert, anteil_steuerbar,
    je_typ, je_hebel, offene_typen,
    kernaussage: baueKernaussage(gesamt, steuerbar, je_hebel, belastbar),
    belastbar,
    hinweis: unklassifiziert !== 0
      ? `${offene_typen.length} Gebührenart(en) über ${unklassifiziert.toFixed(2)} € sind noch nicht ` +
        `eingeordnet. Sie zählen weder als steuerbar noch als unvermeidbar — ` +
        `als „nicht steuerbar" zu buchen wäre eine Entwarnung, die niemand geprüft hat.`
      : null,
  };
}

function baueKernaussage(
  gesamt: number, steuerbar: number, je_hebel: HebelZeile[], belastbar: boolean,
): string {
  if (gesamt <= 0) return "Für diesen Zeitraum liegen keine Gebührenpositionen vor.";
  if (steuerbar <= 0) {
    return belastbar
      ? `${gesamt.toFixed(2)} € Gebühren, davon nichts selbst erzeugt. ` +
        `Was anfällt, ist der Preis des Verkaufens — nicht des Wirtschaftens.`
      : `${gesamt.toFixed(2)} € Gebühren. Bislang keine selbst erzeugten erkannt — ` +
        `aber ein Teil ist noch nicht eingeordnet, die Aussage ist also unvollständig.`;
  }
  const fuehrend = je_hebel[0];
  const hebelText = fuehrend
    ? ` — Hebel: ${hebelLabel(fuehrend.hebel)}${fuehrend.hypothese ? " (Hypothese)" : ""}`
    : "";
  return `${gesamt.toFixed(2)} € Gebühren, davon ${steuerbar.toFixed(2)} € selbst erzeugt${hebelText}.`;
}

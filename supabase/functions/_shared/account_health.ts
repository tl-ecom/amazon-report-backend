// account_health.ts — Amazons Kontozustand aus GET_V2_SELLER_PERFORMANCE_REPORT.
//
// Reines Modul. Die Form stammt aus Vanejas echter Antwort vom 04.10.2026,
// nicht aus der Dokumentation.
//
// ZWEI AUSSAGEN, die getrennt bleiben:
//
//  - AMAZONS STATUS je Kennzahl (GOOD, FAIR, AT_RISK ...). Das ist, was über
//    das Konto entscheidet.
//  - ZIEL VERFEHLT: der gemessene Wert gegen Amazons eigenen Zielwert. Beides
//    kann auseinanderfallen: Vaneja hatte eine pünktliche Lieferquote von 43 %
//    bei einem Ziel von 97 % — und Amazon meldete trotzdem GOOD, weil es nur
//    sieben Sendungen waren. Wer nur den Status zeigt, verschweigt die Zahl;
//    wer nur die Zahl zeigt, schlägt falschen Alarm. Deshalb beides, mit der
//    Menge dahinter.
//
// Die Kennzahlen werden nicht einzeln aufgezählt, sondern aus der Antwort
// gelesen: Amazon hat rund zwanzig, und eine neue soll erscheinen, ohne dass
// hier jemand eine Liste pflegt.

/** Amazons Status-Werte, die KEINEN Handlungsbedarf bedeuten. */
const UNAUFFAELLIG = new Set(["GOOD", "NONE", "GREAT", "NORMAL"]);

export interface Kennzahl {
  kennzahl: string;
  /** Amazons Urteil. null, wenn Amazon zu dieser Kennzahl keinen Status meldet. */
  status: string | null;
  /** Quote als Anteil (0.04 = 4 %). null bei reinen Zählkennzahlen. */
  rate: number | null;
  /** Anzahl Mängel/Verstöße. null bei reinen Quoten. */
  anzahl: number | null;
  ziel: number | null;
  /** LESS_THAN | GREATER_THAN | EQUALS — wie `ziel` zu lesen ist. */
  ziel_bedingung: string | null;
  /** Gemessener Wert gegen Amazons Zielwert. null, wenn nicht prüfbar. */
  ziel_verfehlt: boolean | null;
  /** Wie viele Bestellungen/Sendungen hinter der Quote stehen. null, wenn Amazon keine nennt. */
  menge: number | null;
  von: string | null;
  bis: string | null;
}

function zahl(x: unknown): number | null {
  const n = Number(x);
  return x === null || x === undefined || !Number.isFinite(n) ? null : n;
}

/** Der Wert, den Amazon gegen `targetValue` hält: die Quote, sonst die Mängelzahl. */
export function zielVerfehlt(wert: number | null, ziel: number | null, bedingung: string | null): boolean | null {
  if (wert === null || ziel === null) return null;
  if (bedingung === "LESS_THAN") return !(wert < ziel);
  if (bedingung === "GREATER_THAN") return !(wert > ziel);
  if (bedingung === "EQUALS") return wert !== ziel;
  return null;
}

function kennzahl(name: string, m: any): Kennzahl {
  const rate = zahl(m?.rate);
  const anzahl = zahl(m?.defectsCount);
  const ziel = zahl(m?.targetValue);
  const bedingung = typeof m?.targetCondition === "string" ? m.targetCondition : null;
  return {
    kennzahl: name,
    status: typeof m?.status === "string" ? m.status : null,
    rate,
    anzahl,
    ziel,
    ziel_bedingung: bedingung,
    ziel_verfehlt: zielVerfehlt(rate ?? anzahl, ziel, bedingung),
    // Amazon nennt die Menge je Kennzahl anders. Bei der pünktlichen Lieferung
    // heißt sie shipmentCountWithValidTracking — ohne sie stand genau bei der
    // Kennzahl keine Menge, bei der sie die 43 % erst einordnet.
    menge: zahl(m?.orderCount) ?? zahl(m?.shipmentCount) ?? zahl(m?.totalUnitCount)
      ?? zahl(m?.shipmentCountWithValidTracking),
    von: m?.reportingDateRange?.reportingDateFrom?.slice(0, 10) ?? null,
    bis: m?.reportingDateRange?.reportingDateTo?.slice(0, 10) ?? null,
  };
}

/** Alle Kennzahlen eines Marktplatzes. orderDefectRate kommt je Versandart (afn/mfn). */
export function kennzahlenAus(metrics: Record<string, any>): Kennzahl[] {
  const out: Kennzahl[] = [];
  for (const [name, m] of Object.entries(metrics ?? {})) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    if (name === "accountHealthRating") continue; // eigener Block
    if ("targetValue" in m) out.push(kennzahl(name, m));
    else {
      for (const [unter, u] of Object.entries(m)) {
        if (u && typeof u === "object" && "targetValue" in (u as any)) out.push(kennzahl(`${name}.${unter}`, u));
      }
    }
  }
  return out.sort((a, b) => a.kennzahl.localeCompare(b.kennzahl));
}

export function baueAccountHealth(payload: Record<string, any>, stand: string | null): Record<string, unknown> {
  const statusJe = new Map<string, string>();
  for (const s of payload?.accountStatuses ?? []) statusJe.set(String(s.marketplaceId), String(s.status));

  const marktplaetze = (payload?.performanceMetrics ?? []).map((pm: any) => {
    const kennzahlen = kennzahlenAus(pm);
    const kontoStatus = statusJe.get(String(pm.marketplaceId)) ?? null;
    return {
      marktplatz: pm.marketplaceId ?? null,
      konto_status: kontoStatus,
      rating: {
        punkte: zahl(pm?.accountHealthRating?.ahrScore),
        status: pm?.accountHealthRating?.ahrStatus ?? null,
      },
      verwarnungen: zahl(pm?.policyViolationWarnings?.warningsCount),
      warnzustaende: Array.isArray(pm?.warningStates) ? pm.warningStates : [],
      // Was jemand ansehen sollte: Amazon meldet etwas anderes als "in Ordnung".
      handlungsbedarf: kennzahlen.filter((k) => k.status !== null && !UNAUFFAELLIG.has(k.status)),
      // Amazon meldet "in Ordnung", die Zahl liegt aber jenseits von Amazons
      // eigenem Ziel — meist kleine Mengen. Kein Alarm, aber wissenswert.
      ziel_verfehlt_trotz_gutem_status: kennzahlen.filter((k) =>
        k.ziel_verfehlt === true && (k.status === null || UNAUFFAELLIG.has(k.status))
      ),
      kennzahlen,
    };
  });

  return {
    stand,
    marktplaetze,
    hinweise: [
      "`status` ist Amazons Urteil und das, was über das Konto entscheidet. `ziel_verfehlt` "
      + "vergleicht nur die gemessene Zahl mit Amazons Zielwert — bei kleinen Mengen (`menge`) "
      + "kann eine Quote weit vom Ziel liegen, ohne dass Amazon etwas unternimmt.",
      "Die Kennzahlen haben verschiedene Zeiträume (`von`/`bis`), von sieben Tagen bis sechs Monaten.",
    ],
  };
}

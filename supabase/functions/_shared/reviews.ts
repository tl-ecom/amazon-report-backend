// reviews.ts — Rezensionsthemen aus der Customer-Feedback-API.
//
// Amazon liefert seit v2024-06-01 dieselben Daten, die im Product Opportunity
// Explorer stehen: welche Themen Kunden positiv und negativ nennen, wie oft,
// mit welchem Einfluss auf die Sternebewertung, und den Verlauf ueber Monate.
//
// Was diese Datei NICHT liefert und auch nicht liefern kann: die aktuelle
// Sternezahl, die Anzahl der Bewertungen und den Wortlaut einzelner
// Rezensionen. Die stehen in keiner SP-API. Wer danach fragt, bekommt hier
// keine erfundene Naeherung, sondern den Hinweis auf Seller Central.
//
// PARSEN MIT VORBEHALT: Die Feldnamen der API sind nur teilweise dokumentiert.
// Statt zu raten, probiert `zahl()` mehrere Schreibweisen und gibt null zurueck,
// wenn keine passt — und die Rohantwort wird mitgespeichert. Was der Parser
// heute nicht erkennt, ist damit nicht verloren, sondern nachtraeglich
// auswertbar. Eine 0 statt null waere hier besonders schaedlich: "kein Einfluss
// auf die Sterne" und "Feld nicht gefunden" sind verschiedene Aussagen.

export type Richtung = "positiv" | "negativ";

/** Erste Zahl, die unter einem der Namen steht. null = keiner passte. */
function zahl(o: any, ...namen: string[]): number | null {
  for (const n of namen) {
    const w = o?.[n];
    if (typeof w === "number" && Number.isFinite(w)) return w;
    if (typeof w === "string" && w.trim() !== "" && Number.isFinite(Number(w))) return Number(w);
  }
  return null;
}

function text(o: any, ...namen: string[]): string | null {
  for (const n of namen) {
    const w = o?.[n];
    if (typeof w === "string" && w.trim() !== "") return w.trim();
  }
  return null;
}

/**
 * Zahl, die auch in einem Objekt stecken darf.
 *
 * Auf Browse-Node-Ebene liefert Amazon `occurrencePercentage: {allProducts: 1.71}`
 * statt einer Zahl. Wer hier nur auf Zahlen prueft, bekommt null und haelt den
 * Kategorievergleich fuer nicht vorhanden — genau die Angabe, die den Themen
 * ihren Wert gibt.
 */
function zahlTief(o: any, name: string, ...innen: string[]): number | null {
  const direkt = zahl(o, name);
  if (direkt !== null) return direkt;
  const w = o?.[name];
  if (w && typeof w === "object") {
    return zahl(w, ...(innen.length ? innen : ["allProducts", "value", "all"]));
  }
  return null;
}

/** Erstes Objekt, das unter einem der Namen steht. */
function objekt(o: any, ...namen: string[]): any {
  for (const n of namen) {
    const w = o?.[n];
    if (w && typeof w === "object") return w;
  }
  return null;
}

export interface ThemenZeile {
  richtung: Richtung;
  thema: string;
  nennungen: number | null;
  anteil: number | null;
  stern_einfluss: number | null;
  anteil_parent: number | null;
  anteil_kategorie: number | null;
  schnipsel: unknown;
  unterthemen: unknown;
  roh: unknown;
}

/**
 * Antwort von getItemReviewTopics → Zeilen.
 *
 * Die Metriken stehen je Ebene in einem eigenen Objekt (asinMetrics,
 * parentAsinMetrics, browseNodeMetrics). Der Vergleich zur Kategorie ist der
 * eigentliche Wert: "8 % nennen die Verpackung" sagt wenig, "8 % gegen 2 % in
 * der Kategorie" sagt viel.
 */
export function parseThemen(antwort: any): ThemenZeile[] {
  const raus: ThemenZeile[] = [];

  const seite = (liste: any[], richtung: Richtung) => {
    for (const t of Array.isArray(liste) ? liste : []) {
      const thema = text(t, "topic", "name", "topicName");
      if (!thema) continue;

      const asinM = objekt(t, "asinMetrics") ?? t;
      const parentM = objekt(t, "parentAsinMetrics");
      const nodeM = objekt(t, "browseNodeMetrics");

      raus.push({
        richtung,
        thema,
        nennungen: zahl(asinM, "numberOfMentions", "mentions", "mentionCount", "count"),
        anteil: zahl(asinM, "occurrencePercentage", "percentage", "occurrence"),
        // Wie stark dieses Thema die Sternebewertung zieht. Bei negativen
        // Themen ist das die Zahl, die entscheidet, ob es sich zu handeln lohnt.
        stern_einfluss: zahl(asinM, "starRatingImpact", "ratingImpact", "impact"),
        anteil_parent: zahlTief(parentM, "occurrencePercentage"),
        anteil_kategorie: zahlTief(nodeM, "occurrencePercentage"),
        schnipsel: t?.reviewSnippets ?? t?.snippets ?? null,
        unterthemen: t?.subtopics ?? null,
        roh: t,
      });
    }
  };

  // Die echte Antwort schachtelt unter `topics`. Der Wurzel-Fall bleibt als
  // Rueckfall stehen: kostet nichts und faengt eine Formaenderung ab.
  const wurzel = objekt(antwort, "topics") ?? antwort;
  seite(wurzel?.positiveTopics, "positiv");
  seite(wurzel?.negativeTopics, "negativ");
  return raus;
}

export interface TrendZeile {
  richtung: Richtung;
  thema: string;
  monat: string;
  bis: string | null;
  anteil: number | null;
  anteil_parent: number | null;
  anteil_kategorie: number | null;
  roh: unknown;
}

function tag(v: unknown): string | null {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Antwort von getItemReviewTrends → eine Zeile je Thema und Zeitraum. */
export function parseTrend(antwort: any): TrendZeile[] {
  const raus: TrendZeile[] = [];

  const seite = (liste: any[], richtung: Richtung) => {
    for (const t of Array.isArray(liste) ? liste : []) {
      const thema = text(t, "topic", "name", "topicName");
      if (!thema) continue;
      const punkte = t?.trendMetrics ?? t?.trends ?? t?.metrics ?? t?.trend;
      for (const p of Array.isArray(punkte) ? punkte : []) {
        const spanne = objekt(p, "dateRange") ?? p;
        const von = tag(spanne?.startDate ?? spanne?.start ?? p?.date);
        if (!von) continue;

        const asinM = objekt(p, "asinMetrics") ?? p;
        const parentM = objekt(p, "parentAsinMetrics");
        const nodeM = objekt(p, "browseNodeMetrics");

        raus.push({
          richtung,
          thema,
          monat: von,
          bis: tag(spanne?.endDate ?? spanne?.end),
          anteil: zahlTief(asinM, "occurrencePercentage"),
          anteil_parent: zahlTief(parentM, "occurrencePercentage"),
          anteil_kategorie: zahlTief(nodeM, "occurrencePercentage"),
          roh: p,
        });
      }
    }
  };

  const wurzel = objekt(antwort, "topics") ?? antwort;
  seite(wurzel?.positiveTopics, "positiv");
  seite(wurzel?.negativeTopics, "negativ");
  return raus;
}

// --- Auffaellige Entwicklungen ----------------------------------------------
//
// Die Diagnose-Regel: ein negatives Thema, das NEU auftaucht oder sich
// verdoppelt hat, gehoert gemeldet.
//
// "Verdoppelt" allein reicht dafuer nicht. Ein Thema, das von 2 auf 4 Nennungen
// geht, hat sich verdoppelt und bedeutet nichts — bei zwanzig Themen je ASIN
// passiert das jede Woche irgendwo. Ohne Untergrenze meldet die Diagnose
// Zufall, und wer jede Woche Zufall gemeldet bekommt, liest sie nicht mehr.

/**
 * So viele Nennungen muss ein Thema im JUENGSTEN Monat haben, damit eine
 * Veraenderung ueberhaupt gemeldet wird.
 */
export const NENNUNGEN_MIN = 5;

/** Ab diesem Faktor gilt ein Thema als "verdoppelt". */
export const FAKTOR_WARN = 2;

export interface TrendPunkt { monat: string; anteil: number | null }

export interface Auffaellig {
  thema: string;
  art: "neu" | "verdoppelt";
  monat: string;
  anteil_jetzt: number | null;
  anteil_vorher: number | null;
  faktor: number | null;
  nennungen: number | null;
  begruendung: string;
}

/**
 * Welche negativen Themen sind auffaellig geworden?
 *
 * `nennungen` kommt aus den Themen des aktuellen Stands, `reihe` aus dem Trend.
 * Ohne Nennungen wird NICHT gemeldet: ein Prozentsprung ohne Mengenangabe ist
 * nicht einzuordnen.
 */
export function auffaelligeThemen(
  reihen: Map<string, TrendPunkt[]>,
  nennungen: Map<string, number | null>,
  minNennungen = NENNUNGEN_MIN,
): Auffaellig[] {
  const raus: Auffaellig[] = [];

  for (const [thema, punkteRoh] of reihen) {
    const punkte = punkteRoh.slice().sort((a, b) => a.monat.localeCompare(b.monat));
    if (punkte.length < 2) continue;

    const jetzt = punkte[punkte.length - 1];
    const vorher = punkte[punkte.length - 2];
    const menge = nennungen.get(thema) ?? null;

    // Zu klein, um etwas zu bedeuten — und zu klein heisst auch: unbekannt
    // zaehlt nicht als gross genug.
    if (menge === null || menge < minNennungen) continue;
    if (jetzt.anteil === null) continue;

    // NEU: im Vormonat gar nicht vorhanden oder bei null.
    const warVorher = vorher.anteil !== null && vorher.anteil > 0;
    if (!warVorher) {
      raus.push({
        thema, art: "neu", monat: jetzt.monat,
        anteil_jetzt: jetzt.anteil, anteil_vorher: vorher.anteil, faktor: null,
        nennungen: menge,
        begruendung: `Das Thema taucht im ${jetzt.monat} neu auf (${menge} Nennungen). `
          + "Im Monat davor war es nicht vertreten.",
      });
      continue;
    }

    // `warVorher` hat das schon geprueft; TypeScript sieht das nicht.
    const basis = vorher.anteil as number;
    const faktor = Math.round((jetzt.anteil / basis) * 100) / 100;
    if (faktor >= FAKTOR_WARN) {
      raus.push({
        thema, art: "verdoppelt", monat: jetzt.monat,
        anteil_jetzt: jetzt.anteil, anteil_vorher: vorher.anteil, faktor,
        nennungen: menge,
        begruendung: `Der Anteil ist von ${vorher.anteil} auf ${jetzt.anteil} gestiegen `
          + `(Faktor ${faktor}, ${menge} Nennungen). Das ist eine Beobachtung, keine `
          + "Ursache: Amazon nennt nicht, warum ein Thema haeufiger wird.",
      });
    }
  }

  return raus.sort((a, b) => (b.anteil_jetzt ?? 0) - (a.anteil_jetzt ?? 0));
}

/**
 * Der Satz, der bei JEDER Ausgabe dabeisteht.
 *
 * Ohne ihn liest jemand die Themen als Rezensionsauswertung und wundert sich,
 * wo die Sterne sind.
 */
export const GRENZEN = [
  "Themennamen kommen in der Sprache des Marktplatzes: bei Amazon.de auf "
  + "DEUTSCH. Amazons Dokumentation sagt „nur Englisch\" — am echten Abruf "
  + "gemessen stimmt das nicht.",
  "Die Daten werden von Amazon WÖCHENTLICH aufgefrischt. Ein Abruf am Folgetag "
  + "liefert dieselben Zahlen.",
  "Sternezahl, Anzahl der Bewertungen und der Wortlaut einzelner Rezensionen "
  + "sind hier NICHT enthalten. Die gibt keine SP-API her; dafür bleibt Seller "
  + "Central oder ein Drittanbieter.",
  "Rezensionen sind je Marktplatz verschieden. Die Themen gelten für den "
  + "abgefragten Marktplatz, nicht für das Produkt insgesamt.",
];

// --- Lesezugriff ------------------------------------------------------------

export interface ReviewArgs {
  asin?: unknown; marktplatz?: unknown; richtung?: unknown; limit?: unknown;
}

/**
 * Themen einer ASIN mit Veraenderung gegenueber dem Vormonat.
 *
 * Ohne `asin`: welche ASINs ueberhaupt Daten haben. Das ist die ehrlichere
 * Voreinstellung als eine willkuerlich gewaehlte ASIN.
 */
export async function reviewThemen(
  supabase: any, tenant_id: string, args: ReviewArgs = {},
): Promise<unknown> {
  const asin = String(args.asin ?? "").trim().toUpperCase();
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));

  const { data: mpRow } = await supabase.from("auth_contexts")
    .select("marketplace_id").eq("tenant_id", tenant_id).eq("source", "sp").maybeSingle();
  const marktplatz = String(args.marktplatz ?? "").trim() || String(mpRow?.marketplace_id ?? "");

  if (!asin) {
    const { data } = await supabase.from("reviews_laeufe")
      .select("asin, marktplatz, stand, status, themen, meldung")
      .eq("tenant_id", tenant_id).order("stand", { ascending: false }).limit(200);
    return {
      asins: data ?? [],
      hinweis: "Ohne 'asin' die Liste der abgerufenen ASINs. Mit 'asin' die Themen.",
      grenzen: GRENZEN,
    };
  }

  const { data: themen, error } = await supabase.from("reviews_themen")
    .select("stand, richtung, thema, nennungen, anteil, stern_einfluss, anteil_parent, anteil_kategorie, schnipsel")
    .eq("tenant_id", tenant_id).eq("marktplatz", marktplatz).eq("asin", asin)
    .order("stand", { ascending: false }).limit(limit * 2);
  if (error) throw new Error(`reviews_themen: ${error.message}`);

  const staende = [...new Set((themen ?? []).map((t: any) => String(t.stand)))].sort().reverse();
  const neuster = staende[0] ?? null;
  const aktuell = (themen ?? []).filter((t: any) => String(t.stand) === neuster);

  const { data: trend } = await supabase.from("reviews_trend")
    .select("richtung, thema, monat, bis, anteil, anteil_parent, anteil_kategorie")
    .eq("tenant_id", tenant_id).eq("marktplatz", marktplatz).eq("asin", asin)
    .order("monat", { ascending: true });

  // Veraenderung gegenueber dem Vormonat je Thema.
  const reihen = new Map<string, TrendPunkt[]>();
  for (const t of trend ?? []) {
    const k = `${t.richtung}|${t.thema}`;
    if (!reihen.has(k)) reihen.set(k, []);
    reihen.get(k)!.push({ monat: String(t.monat), anteil: t.anteil === null ? null : Number(t.anteil) });
  }

  const mitDelta = aktuell.map((t: any) => {
    const punkte = (reihen.get(`${t.richtung}|${t.thema}`) ?? [])
      .slice().sort((a, b) => a.monat.localeCompare(b.monat));
    const jetzt = punkte[punkte.length - 1] ?? null;
    const vorher = punkte[punkte.length - 2] ?? null;
    return {
      ...t,
      trend_monat: jetzt?.monat ?? null,
      anteil_vormonat: vorher?.anteil ?? null,
      veraenderung: jetzt?.anteil != null && vorher?.anteil != null
        ? Math.round((jetzt.anteil - vorher.anteil) * 100) / 100
        : null,
    };
  });

  // Nur negative Themen taugen fuer die Diagnose — ein haeufiger werdendes
  // Lob ist keine Massnahme.
  const negativReihen = new Map<string, TrendPunkt[]>();
  const negativNennungen = new Map<string, number | null>();
  for (const [k, p] of reihen) {
    if (!k.startsWith("negativ|")) continue;
    const thema = k.slice("negativ|".length);
    negativReihen.set(thema, p);
  }
  for (const t of aktuell) {
    if (t.richtung === "negativ") {
      negativNennungen.set(String(t.thema), t.nennungen === null ? null : Number(t.nennungen));
    }
  }

  return {
    asin,
    marktplatz,
    stand: neuster,
    themen: mitDelta,
    auffaellig: auffaelligeThemen(negativReihen, negativNennungen),
    trend: trend ?? [],
    grenzen: GRENZEN,
  };
}

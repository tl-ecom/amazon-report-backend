// abdeckung.ts — Lücken in den Abrechnungsdaten erkennen und benennen.
//
// Alles, was aus settlement_zeilen gerechnet wird (Anlieferung, Lagerung,
// Werbekosten laut Amazon), ist nur so vollständig wie die vorliegenden
// Abrechnungen. Fehlt ein Zeitraum, sind die Summen zu niedrig — und sehen
// trotzdem aus wie fertige Zahlen.
//
// Genau deshalb gibt es dieses Modul: Eine Lücke muss man sehen können, sonst
// hält man ein unvollständiges Ergebnis für ein vollständiges. Es ist derselbe
// Fehler wie beim Ads-Ausfall — nur dass hier nichts kaputtgeht, sondern
// stillschweigend fehlt.

export interface Abdeckung {
  settlement_id: string;
  von: string;
  bis: string;
  zeilen: number | string;
}

export interface Luecke {
  von: string;
  bis: string;
  tage: number;
}

const TAG_MS = 86_400_000;

function tagPlus(datum: string, tage: number): string {
  const d = new Date(datum + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

function tageZwischen(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / TAG_MS,
  );
}

/**
 * Lücken zwischen den abgedeckten Zeiträumen.
 *
 * `mindestTage` filtert Tagesgrenzen weg: Abrechnungen stossen selten exakt
 * aneinander, ein bis zwei Tage Abstand sind normal und keine Lücke. Erst
 * mehrere Tage bedeuten, dass eine Abrechnung fehlt.
 *
 * Die Zeiträume dürfen sich überlappen und unsortiert kommen — beides tritt
 * real auf, weil Amazon Abrechnungen nachreicht.
 */
export function findeLuecken(bereiche: Abdeckung[], mindestTage = 3): Luecke[] {
  const sortiert = [...bereiche]
    .filter((b) => b.von && b.bis)
    .sort((a, b) => a.von.localeCompare(b.von));
  if (sortiert.length < 2) return [];

  const luecken: Luecke[] = [];
  let erreicht = sortiert[0].bis;

  for (const b of sortiert.slice(1)) {
    // Überlappt oder schliesst an -> nur die Reichweite verlängern.
    if (b.von <= erreicht) {
      if (b.bis > erreicht) erreicht = b.bis;
      continue;
    }
    const von = tagPlus(erreicht, 1);
    const bis = tagPlus(b.von, -1);
    const tage = tageZwischen(von, bis) + 1;
    if (tage >= mindestTage) luecken.push({ von, bis, tage });
    if (b.bis > erreicht) erreicht = b.bis;
  }
  return luecken;
}

/** Erster und letzter abgedeckter Tag, oder null wenn nichts vorliegt. */
export function abgedeckterZeitraum(bereiche: Abdeckung[]): { von: string; bis: string } | null {
  const gueltig = bereiche.filter((b) => b.von && b.bis);
  if (gueltig.length === 0) return null;
  return {
    von: gueltig.reduce((m, b) => (b.von < m ? b.von : m), gueltig[0].von),
    bis: gueltig.reduce((m, b) => (b.bis > m ? b.bis : m), gueltig[0].bis),
  };
}

/**
 * Klartext für die Anzeige. Bewusst konkret mit Datum und Dauer — „Daten
 * unvollständig" allein sagt niemandem, was zu tun ist.
 */
export function abdeckungsHinweise(bereiche: Abdeckung[], mindestTage = 3): string[] {
  const hinweise: string[] = [];
  const zeitraum = abgedeckterZeitraum(bereiche);

  if (!zeitraum) {
    hinweise.push("Keine Abrechnungsdaten vorhanden — alle daraus gerechneten Kosten fehlen.");
    return hinweise;
  }

  for (const l of findeLuecken(bereiche, mindestTage)) {
    hinweise.push(
      `Abrechnungslücke ${l.von} bis ${l.bis} (${l.tage} Tage) — Kosten aus diesem Zeitraum fehlen, ` +
        "die Summen sind insoweit zu niedrig.",
    );
  }
  return hinweise;
}

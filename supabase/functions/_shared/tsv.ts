// tsv.ts — Amazons Flat-File-Reports (TSV) einlesen.
//
// Reines Modul: Bytes/Text rein, Zeilen als Objekte raus. Kein Netz, keine DB.
//
// ZEICHENSATZ (die unangenehme Stelle): Amazons Flat-File-Reports sind für die
// EU-Marktplätze historisch NICHT UTF-8, sondern ISO-8859-1 / Windows-1252.
// getReportDocument sagt einem das nicht zuverlässig. Liest man sie stur als
// UTF-8, werden aus Umlauten Fragezeichen oder U+FFFD — und zwar still, ohne
// Fehler. Deshalb: erst UTF-8 mit fatal:true versuchen (wirft bei ungültigen
// Sequenzen), bei Fehlschlag auf Windows-1252 zurückfallen. Das ist deterministisch
// und rät nicht anhand von Ersatzzeichen herum.
//
// Amazons Flat Files quoten NICHT (kein CSV-Quoting) — Felder werden schlicht an
// Tabs getrennt. Ein Feldwert kann daher kein Tab enthalten.

export interface TsvErgebnis {
  format: "tsv";
  encoding: "utf-8" | "windows-1252";
  header: string[];
  rows: Record<string, string>[];
  rowCount: number;
  /** Gesetzt, wenn Spalten bewusst verworfen wurden (z.B. personenbezogene). */
  entfernteSpalten?: string[];
}

/**
 * Dekodiert die Rohbytes. UTF-8 bevorzugt, sonst Windows-1252.
 * Windows-1252 ist eine Obermenge von ISO-8859-1 — deshalb der Vorzug.
 */
export function dekodiere(bytes: Uint8Array): { text: string; encoding: "utf-8" | "windows-1252" } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    // Kein gültiges UTF-8 → Amazons Flat-File-Zeichensatz.
    const text = new TextDecoder("windows-1252").decode(bytes);
    return { text, encoding: "windows-1252" };
  }
}

/**
 * Zerlegt TSV-Text in Kopfzeile + Datenzeilen.
 * Verträgt \n und \r\n, ignoriert leere Zeilen am Ende.
 */
export function parseTsv(text: string, encoding: "utf-8" | "windows-1252" = "utf-8"): TsvErgebnis {
  const zeilen = text.split(/\r?\n/);

  // Führende Leerzeilen überspringen, dann ist die erste echte Zeile der Header.
  let i = 0;
  while (i < zeilen.length && zeilen[i].trim() === "") i++;

  if (i >= zeilen.length) {
    return { format: "tsv", encoding, header: [], rows: [], rowCount: 0 };
  }

  const header = zeilen[i].split("\t").map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let j = i + 1; j < zeilen.length; j++) {
    const zeile = zeilen[j];
    // Leerzeilen (v.a. die letzte nach dem abschließenden \n) überspringen.
    if (zeile.trim() === "") continue;

    const felder = zeile.split("\t");
    const row: Record<string, string> = {};
    for (let k = 0; k < header.length; k++) {
      // Fehlende Felder am Zeilenende → leerer String, nicht undefined.
      row[header[k]] = (felder[k] ?? "").trim();
    }
    rows.push(row);
  }

  return { format: "tsv", encoding, header, rows, rowCount: rows.length };
}

/** Bytes → fertiges Ergebnis. Bequemer Einstieg für die Edge Function. */
export function parseTsvBytes(bytes: Uint8Array): TsvErgebnis {
  const { text, encoding } = dekodiere(bytes);
  return parseTsv(text, encoding);
}

/**
 * Prüft, ob das Dokument überhaupt ein Flat-File ist.
 *
 * WARUM DAS NÖTIG IST (real passiert am 2026-07-17): Amazon liefert Fehler
 * teilweise ALS REPORT-INHALT aus, mit processingStatus DONE und HTTP 200.
 * Ein 90-Tage-Orders-Report kam als Dokument mit dem Text
 *   "Date range exceeded. Report can be requested only upto 30 days"
 * zurück. Ohne diese Prüfung wird so eine Meldung als gültiger Datensatz
 * gespeichert und überschreibt die vorherigen, guten Daten — lautlos.
 *
 * Erkennungsregel: ein echtes Flat-File hat mehrere tab-getrennte Spalten.
 * Eine Fehlermeldung enthält keine Tabs und ergibt daher genau "eine Spalte".
 */
export function pruefeFlatFile(e: TsvErgebnis): { ok: true } | { ok: false; grund: string } {
  if (e.header.length === 0) {
    return { ok: false, grund: "Leeres Dokument — keine Kopfzeile." };
  }
  if (e.header.length === 1) {
    return {
      ok: false,
      grund: `Kein Flat-File (nur eine Spalte, keine Tabs). Amazon liefert hier vermutlich eine Meldung statt Daten: "${e.header[0].slice(0, 300)}"`,
    };
  }
  return { ok: true };
}

/**
 * Verwirft Spalten VOR dem Speichern — gedacht für personenbezogene Felder.
 * Datenminimierung (DSGVO Art. 5(1)(c)): was gar nicht erst gespeichert wird,
 * braucht keine Löschfrist und keine AVV-Abdeckung.
 *
 * Die entfernten Spalten werden im Ergebnis vermerkt, damit später niemand
 * rätselt, warum ein Feld aus Amazons Report hier fehlt.
 * Spalten, die gar nicht vorkommen, werden still ignoriert — Amazon ändert die
 * Flat-File-Spalten gelegentlich, das darf nicht zum Fehler führen.
 */
export function entferneSpalten(e: TsvErgebnis, spalten: string[]): TsvErgebnis {
  if (spalten.length === 0) return e;

  const raus = new Set(spalten);
  const tatsaechlichEntfernt = e.header.filter((h) => raus.has(h));
  if (tatsaechlichEntfernt.length === 0) return e;

  const header = e.header.filter((h) => !raus.has(h));
  const rows = e.rows.map((r) => {
    const neu: Record<string, string> = {};
    for (const h of header) neu[h] = r[h];
    return neu;
  });

  return { ...e, header, rows, rowCount: rows.length, entfernteSpalten: tatsaechlichEntfernt };
}

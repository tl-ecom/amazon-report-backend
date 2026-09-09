// cashflow_plan.ts — Zahlungskalender: was bewegt sich wann.
//
// Die Tabellen davor beantworten "wie ist der Rhythmus". Diese Datei beantwortet
// die Frage, die man morgens wirklich hat: WANN kommt oder geht das nächste
// Geld, und wie viel. Dafür werden die gemessenen Muster in die Zukunft
// fortgeschrieben.
//
// Der heikle Teil ist nicht das Rechnen, sondern die Ehrlichkeit: eine Prognose
// sieht aus wie eine Tatsache, sobald sie in einer Tabelle steht. Deshalb trägt
// jede Position hier zwei Angaben mit — `sicher` (aus Daten belegt oder
// fortgeschrieben) und `grundlage` (in einem Satz, woher der Betrag kommt).
// Wer die Zahl weiterverwendet, soll ihr Gewicht sehen, ohne nachfragen zu
// müssen.
//
// Ein Kontostand kommt hier bewusst NICHT heraus. Das Startguthaben bei Amazon
// kennt Pulse nicht, und ein Saldo ohne Startwert wäre eine erfundene Zahl.
// Gezeigt werden nur Bewegungen und ihre Summe.

import type { Rhythmus, TerminMuster, WerbungMuster } from "./cashflow.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

const TAG = 86400000;

export type ZahlungsArt =
  | "auszahlung" | "lagergebuehr" | "langzeitlager" | "kontogebuehr"
  | "werbung" | "umsatzsteuer";

export interface Zahlung {
  /** YYYY-MM-DD. */
  am: string;
  art: ZahlungsArt;
  bezeichnung: string;
  /** Positiv = Zufluss, negativ = Abfluss. null = Termin bekannt, Betrag nicht. */
  betrag: number | null;
  /** true = aus den Daten belegt. false = aus dem Muster fortgeschrieben. */
  sicher: boolean;
  /** In einem Satz: woher dieser Betrag kommt. */
  grundlage: string;
}

export interface Zahlungsplan {
  von: string;
  bis: string;
  positionen: Zahlung[];
  /** Summe je Kalenderwoche — der Blick, den man für Bestellentscheidungen braucht. */
  wochen: Array<{ ab: string; zufluss: number; abfluss: number; saldo: number; unsicher: boolean }>;
  summe_zufluss: number;
  summe_abfluss: number;
  hinweise: string[];
}

function iso(d: number | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/** Montag der Woche, in der das Datum liegt. */
function wochenstart(datum: string): string {
  const d = new Date(`${datum}T00:00:00Z`);
  const wt = (d.getUTCDay() + 6) % 7; // Montag = 0
  return iso(d.getTime() - wt * TAG);
}

/**
 * Wiederkehrender Monatstermin: die nächsten Vorkommen von `tag` im Fenster.
 * Ein Tag jenseits des Monatsendes (der 31. im Februar) rutscht auf den letzten
 * Tag des Monats, statt in den Folgemonat zu springen.
 */
function monatsTermine(tag: number, ab: Date, bis: Date): string[] {
  const treffer: string[] = [];
  const d = new Date(Date.UTC(ab.getUTCFullYear(), ab.getUTCMonth(), 1));
  while (d.getTime() <= bis.getTime()) {
    const letzter = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const termin = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(tag, letzter));
    if (termin >= ab.getTime() && termin <= bis.getTime()) treffer.push(iso(termin));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return treffer;
}

export interface PlanEingabe {
  rhythmus: Rhythmus;
  /** Median der bisherigen echten Auszahlungen — die Schätzgrundlage. */
  typische_auszahlung: number | null;
  termine: TerminMuster[];
  werbung: WerbungMuster;
  /** Fälligkeit und Betrag der Umsatzsteuer, falls beides bekannt ist. */
  umsatzsteuer: { faellig_am: string | null; betrag: number | null };
  tage?: number;
}

const NAME: Record<string, { art: ZahlungsArt; label: string }> = {
  "FBA Inventory Storage Fee": { art: "lagergebuehr", label: "Lagergebühr" },
  "FBA Long Term Storage Fee": { art: "langzeitlager", label: "Langzeit-Lagergebühr" },
  "other-transaction": { art: "kontogebuehr", label: "Kontogebühr" },
};

export function zahlungsplan(e: PlanEingabe, heute = new Date()): Zahlungsplan {
  const tage = Math.min(180, Math.max(14, e.tage ?? 60));
  const ab = new Date(`${iso(heute)}T00:00:00Z`);
  const bis = new Date(ab.getTime() + tage * TAG);
  const positionen: Zahlung[] = [];
  const hinweise: string[] = [];

  // --- Auszahlungen -------------------------------------------------------
  // Die Termine sind gemessen, die BETRÄGE nicht. Amazon sagt vorher nicht, wie
  // viel kommt; die einzige begründbare Schätzung ist die bisherige typische
  // Auszahlung. Sie steht deshalb als unsicher da, nie als Zusage.
  for (const t of e.rhythmus.naechste) {
    const am = t.auszahlung_am.slice(0, 10);
    if (am < iso(ab) || am > iso(bis)) continue;
    positionen.push({
      am,
      art: "auszahlung",
      bezeichnung: t.geschaetzt ? "Auszahlung (fortgeschrieben)" : "Auszahlung",
      betrag: e.typische_auszahlung === null ? null : r2(e.typische_auszahlung),
      // Der TERMIN der bereits geschlossenen Periode ist sicher, der Betrag nie.
      sicher: false,
      grundlage: e.typische_auszahlung === null
        ? "Termin aus dem gemessenen Rhythmus; für den Betrag fehlen Vergleichswerte."
        : (t.geschaetzt
          ? "Termin fortgeschrieben, Betrag = bisherige typische Auszahlung."
          : "Periode ist bereits geschlossen, der Termin steht fest. "
            + "Der Betrag ist die bisherige typische Auszahlung, nicht der echte."),
    });
  }
  if (e.rhythmus.naechste.length === 0) {
    hinweise.push(
      "Ohne gemessenen Auszahlungsrhythmus stehen im Kalender keine Zuflüsse. "
      + "Sie werden nicht geschätzt, sondern weggelassen.",
    );
  }

  // --- Terminbuchungen ----------------------------------------------------
  for (const t of e.termine) {
    if (t.tag_im_monat === null) {
      hinweise.push(
        `„${NAME[t.art]?.label ?? t.art}" hat keinen wiederkehrenden Buchungstag `
        + `(${t.treffer} von ${t.belege} Belegen am selben Tag) und steht deshalb `
        + "nicht im Kalender.",
      );
      continue;
    }
    const info = NAME[t.art] ?? { art: "kontogebuehr" as ZahlungsArt, label: t.art };
    for (const am of monatsTermine(t.tag_im_monat, ab, bis)) {
      positionen.push({
        am,
        art: info.art,
        bezeichnung: info.label,
        betrag: t.schnitt_betrag,
        sicher: false,
        grundlage: `Bisher immer am ${t.tag_im_monat}. des Monats `
          + `(${t.treffer} von ${t.belege} Belegen). Betrag = bisheriger Mittelwert.`,
      });
    }
  }

  // --- Werbung ------------------------------------------------------------
  // Kein Termin, sondern ein laufender Abfluss an einer Rechnungsschwelle.
  // Einzelne Buchungen in den Kalender zu schreiben wäre Scheingenauigkeit —
  // wann genau die Schwelle reißt, hängt am Tagesumsatz. Deshalb je Woche.
  if (e.werbung.je_tag !== null && e.werbung.art !== "zu_wenig_daten") {
    const proTag = e.werbung.je_tag; // bereits negativ
    let w = new Date(`${wochenstart(iso(ab))}T00:00:00Z`);
    while (w.getTime() <= bis.getTime()) {
      // Nur die Tage zählen, die wirklich im Fenster liegen.
      const start = Math.max(w.getTime(), ab.getTime());
      const ende = Math.min(w.getTime() + 6 * TAG, bis.getTime());
      const anzahl = Math.round((ende - start) / TAG) + 1;
      if (anzahl > 0) {
        positionen.push({
          am: iso(start),
          art: "werbung",
          bezeichnung: `Werbekosten (${anzahl} Tage)`,
          betrag: r2(proTag * anzahl),
          sicher: false,
          grundlage: e.werbung.art === "rechnungsschwelle"
            ? `Laufender Abzug an einer Rechnungsschwelle von rund `
              + `${Math.abs(e.werbung.schwelle ?? 0).toFixed(2)} €. `
              + `Hochgerechnet aus ${Math.abs(proTag).toFixed(2)} € je Tag im Messfenster.`
            : `Hochgerechnet aus ${Math.abs(proTag).toFixed(2)} € je Tag im Messfenster.`,
        });
      }
      w = new Date(w.getTime() + 7 * TAG);
    }
  } else {
    hinweise.push(
      "Für die Werbekosten gibt es zu wenige Buchungen im Messfenster. Sie fehlen "
      + "im Kalender — der Abfluss ist damit zu günstig dargestellt.",
    );
  }

  // --- Umsatzsteuer -------------------------------------------------------
  if (e.umsatzsteuer.faellig_am) {
    const am = e.umsatzsteuer.faellig_am;
    if (am >= iso(ab) && am <= iso(bis)) {
      positionen.push({
        am,
        art: "umsatzsteuer",
        bezeichnung: "Umsatzsteuer-Voranmeldung",
        betrag: e.umsatzsteuer.betrag === null ? null : -Math.abs(e.umsatzsteuer.betrag),
        sicher: false,
        grundlage: "Abgabetermin aus dem hinterlegten Rhythmus. Betrag aus den "
          + "Amazon-Daten des letzten abgerechneten Monats — Vorsteuer aus "
          + "Wareneinkauf und Betriebsausgaben fehlt, die echte Zahllast ist niedriger.",
      });
    }
  } else {
    hinweise.push(
      "Die Umsatzsteuer fehlt im Kalender, weil der Voranmeldungs-Rhythmus nicht "
      + "hinterlegt ist. Das ist meist der größte Einzelabfluss des Monats.",
    );
  }

  positionen.sort((a, b) => a.am.localeCompare(b.am) || a.art.localeCompare(b.art));

  // --- Wochensummen -------------------------------------------------------
  const nachWoche = new Map<string, { zufluss: number; abfluss: number; unsicher: boolean }>();
  for (const p of positionen) {
    const k = wochenstart(p.am);
    const w = nachWoche.get(k) ?? { zufluss: 0, abfluss: 0, unsicher: false };
    if (p.betrag === null) w.unsicher = true;
    else if (p.betrag >= 0) w.zufluss += p.betrag;
    else w.abfluss += p.betrag;
    if (!p.sicher) w.unsicher = true;
    nachWoche.set(k, w);
  }
  const wochen = [...nachWoche.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([abWoche, w]) => ({
      ab: abWoche,
      zufluss: r2(w.zufluss),
      abfluss: r2(w.abfluss),
      saldo: r2(w.zufluss + w.abfluss),
      unsicher: w.unsicher,
    }));

  return {
    von: iso(ab),
    bis: iso(bis),
    positionen,
    wochen,
    summe_zufluss: r2(positionen.reduce((s, p) => s + Math.max(0, p.betrag ?? 0), 0)),
    summe_abfluss: r2(positionen.reduce((s, p) => s + Math.min(0, p.betrag ?? 0), 0)),
    hinweise,
  };
}

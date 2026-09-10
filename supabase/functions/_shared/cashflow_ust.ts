// cashflow_ust.ts — Umsatzsteuer-Zahllast aus den Amazon-Verkäufen.
//
// Der größte Posten der Amazon-Cash-Rechnung und der, den man am leichtesten
// übersieht: Amazon zahlt den BRUTTOumsatz aus. Die Umsatzsteuer darin gehört
// dem Finanzamt, nicht dem Verkäufer. Bei Vaneja waren das im August 9.083 €
// vereinnahmt gegen rund 3.628 € Vorsteuer aus Gebühren — gut 5.400 €, die auf
// dem Konto liegen und längst verplant sind. Wer sie als Guthaben liest, plant
// mit fremdem Geld.
//
// Die Steuersätze müssen dafür NICHT bekannt sein. Amazon bucht den
// tatsächlichen Steuerbetrag je Zeile. Damit stimmt die Rechnung auch für ein
// Sortiment mit 7 % und 19 % nebeneinander, ohne dass jemand pflegen muss,
// welcher Artikel in welchen Satz fällt — und ohne dass ein Pflegefehler still
// in die Zahllast durchschlägt.
//
// Wichtig für den deutschen Regelfall: Hier führt der VERKÄUFER die Steuer
// selbst ab, anders als in den USA, wo Amazon als Marketplace Facilitator
// einbehält. Der volle vereinnahmte Betrag ist deshalb eigene Schuld und ein
// echter Abfluss. An den Daten bestätigt: über die gesamte Vaneja-Historie
// steht auf Amazon.de keine einzige einbehaltene Zeile; die einzigen beiden
// stammen von Amazon.fr. Der Abzug bleibt trotzdem im Code — für Auslands-
// umsätze kommt er vor, und ihn zu ignorieren hiesse, dort eine Schuld
// auszuweisen, die schon beglichen ist.

import { naechsteAnmeldung } from "./cashflow.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

export interface UstZeile {
  monat: string;
  marktplatz: string;
  vereinnahmt_cents: number;
  einbehalten_cents: number;
  vorsteuer_ausgewiesen_cents: number;
  gebuehren_brutto_cents: number;
}

/**
 * Ein Marktplatz eines Monats, vollstaendig durchgerechnet.
 *
 * Auslandsumsaetze zu einer Summe zu addieren hilft niemandem: jedes Land hat
 * seine eigene Meldung (OSS oder lokale Registrierung), und wer in Frankreich
 * meldet, braucht die franzoesische Zahl, nicht die Summe aus vier Laendern.
 */
export interface UstMarktplatz {
  marktplatz: string;
  /** ISO-Land, aus der Domain abgeleitet. null = nicht zuordenbar. */
  land: string | null;
  inland: boolean;
  vereinnahmt: number;
  amazon_abgefuehrt: number;
  vorsteuer: number | null;
  zahllast_aus_amazon: number | null;
}

export interface UstMonat {
  monat: string;
  vereinnahmt: number;
  /** Davon hat Amazon selbst abgeführt (Marketplace Facilitator). */
  amazon_abgefuehrt: number;
  /** Vorsteuer aus Amazon-Gebühren. null = Steuerfaktor nicht bestätigt. */
  vorsteuer: number | null;
  /** Was aus den Amazon-Daten ALLEIN übrig bleibt. Nicht die Zahllast. */
  zahllast_aus_amazon: number | null;
  ausland: Array<{ marktplatz: string; vereinnahmt: number; amazon_abgefuehrt: number }>;
  ausland_summe: number;
  /** Von der Auslandssumme hat Amazon diesen Teil selbst abgeführt. */
  ausland_abgefuehrt: number;
  /**
   * Vorsteuer aus Gebühren AUSLÄNDISCHER Marktplätze. Gehört nicht in die
   * deutsche Voranmeldung — steht hier nur, damit der Unterschied zur
   * Gesamt-Vorsteuer nachvollziehbar ist und niemand zwei Zahlen vergleicht,
   * die verschiedene Grundmengen haben.
   */
  ausland_vorsteuer: number | null;
  /** Jeder Marktplatz einzeln — Inland und Ausland, ohne Vermischung. */
  je_marktplatz: UstMarktplatz[];
}

export interface Umsatzsteuer {
  monate: UstMonat[];
  faellig_am: string | null;
  rhythmus: string | null;
  hinweise: string[];
}

export interface UstProfil {
  faktor: number | null;
  abzugsberechtigt: boolean | null;
  land: string;
  rhythmus: string | null;
  dauerfrist: boolean | null;
  oss: boolean | null;
}

/**
 * Marktplatz-Domain -> Land.
 *
 * Ausdrücklich eine NÄHERUNG: Ein Fernverkauf über Amazon.de an einen
 * französischen Kunden trägt französische Steuer und landet hier trotzdem im
 * Inland. Genau steht das erst im Umsatzsteuer-Transaktionsbericht. Der
 * Vorbehalt wandert in die Hinweise, statt still in der Zahl zu verschwinden.
 */
export function marktplatzLand(marktplatz: string): string | null {
  const m = (marktplatz ?? "").toLowerCase();
  // Längere Endungen zuerst, sonst schluckt "amazon.com" das "amazon.com.be".
  const paare: Array<[string, string]> = [
    ["amazon.com.be", "BE"], ["amazon.com.tr", "TR"], ["amazon.co.uk", "GB"],
    ["amazon.de", "DE"], ["amazon.fr", "FR"], ["amazon.it", "IT"],
    ["amazon.es", "ES"], ["amazon.nl", "NL"], ["amazon.pl", "PL"],
    ["amazon.se", "SE"], ["amazon.ie", "IE"],
  ];
  for (const [muster, land] of paare) if (m.includes(muster)) return land;
  return null;
}

export function umsatzsteuerZahllast(
  zeilen: UstZeile[], profil: UstProfil, heute = new Date(),
): Umsatzsteuer {
  const nachMonat = new Map<string, UstZeile[]>();
  for (const z of zeilen) {
    const liste = nachMonat.get(z.monat) ?? [];
    liste.push(z);
    nachMonat.set(z.monat, liste);
  }

  let auslandGesehen = false;
  let inlandEinbehalten = 0;

  const monate: UstMonat[] = [...nachMonat.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([monat, liste]) => {
      // Was sich keinem Land zuordnen lässt, zählt zum Inland. Es dem Ausland
      // zuzuschlagen würde die OSS-Summe aufblähen, und der häufigste Fall
      // (Liquidationen, Non-Amazon-Kanäle) ist tatsächlich inländisch.
      const heimisch = liste.filter((z) => {
        const l = marktplatzLand(z.marktplatz);
        return l === null || l === profil.land;
      });
      const ausland = liste.filter((z) => {
        const l = marktplatzLand(z.marktplatz);
        return l !== null && l !== profil.land;
      });

      const summe = (xs: UstZeile[], feld: keyof UstZeile) =>
        xs.reduce((s, z) => s + (Number(z[feld]) || 0), 0);

      const vereinnahmt = summe(heimisch, "vereinnahmt_cents") / 100;
      const abgefuehrt = Math.abs(summe(heimisch, "einbehalten_cents")) / 100;
      inlandEinbehalten += abgefuehrt;

      // Vorsteuer: der ausgewiesene Teil ("Tax on fee") plus der in den
      // Bestellgebühren eingerechnete. Ohne Abzugsberechtigung fällt beides
      // weg — dann ist die Steuer in den Gebühren endgültige Kosten.
      const bruttoGeb = Math.abs(summe(heimisch, "gebuehren_brutto_cents"));
      const ausgewiesen = Math.abs(summe(heimisch, "vorsteuer_ausgewiesen_cents")) / 100;
      const eingerechnet = profil.faktor === null
        ? null
        : (bruttoGeb - bruttoGeb / profil.faktor) / 100;
      const vorsteuer = profil.abzugsberechtigt === false
        ? 0
        : (eingerechnet === null ? null : r2(ausgewiesen + eingerechnet));

      // Derselbe Rechenweg wie im Inland, nur fuer die uebrigen Marktplaetze.
      const auslandBrutto = Math.abs(summe(ausland, "gebuehren_brutto_cents"));
      const auslandAusgewiesen = Math.abs(summe(ausland, "vorsteuer_ausgewiesen_cents")) / 100;
      const auslandVorsteuer = profil.abzugsberechtigt === false
        ? 0
        : (profil.faktor === null
          ? null
          : r2(auslandAusgewiesen + (auslandBrutto - auslandBrutto / profil.faktor) / 100));

      // Derselbe Rechenweg je einzelnem Marktplatz. Die RPC liefert genau eine
      // Zeile je (Monat, Marktplatz), deshalb ist hier keine Gruppierung noetig.
      const jeMarktplatz: UstMarktplatz[] = liste.map((z) => {
        const brutto = Math.abs(Number(z.gebuehren_brutto_cents) || 0);
        const ausgew = Math.abs(Number(z.vorsteuer_ausgewiesen_cents) || 0) / 100;
        const vst = profil.abzugsberechtigt === false
          ? 0
          : (profil.faktor === null
            ? null
            : r2(ausgew + (brutto - brutto / profil.faktor) / 100));
        const ein = (Number(z.vereinnahmt_cents) || 0) / 100;
        const abg = Math.abs(Number(z.einbehalten_cents) || 0) / 100;
        const l = marktplatzLand(z.marktplatz);
        return {
          marktplatz: z.marktplatz,
          land: l,
          inland: l === null || l === profil.land,
          vereinnahmt: r2(ein),
          amazon_abgefuehrt: r2(abg),
          vorsteuer: vst,
          zahllast_aus_amazon: vst === null ? null : r2(ein - abg - vst),
        };
      }).sort((a, b) =>
        // Inland zuerst, danach nach Umsatzsteuer absteigend: die Reihenfolge,
        // in der man sie braucht.
        (a.inland === b.inland ? 0 : a.inland ? -1 : 1) || (b.vereinnahmt - a.vereinnahmt)
      );

      const auslandListe = ausland
        .map((z) => ({
          marktplatz: z.marktplatz,
          vereinnahmt: r2(z.vereinnahmt_cents / 100),
          // Was Amazon im Ausland schon abgeführt hat, schuldet der Verkäufer
          // dort nicht mehr. Genau hier kommt der Fall tatsächlich vor.
          amazon_abgefuehrt: r2(Math.abs(z.einbehalten_cents) / 100),
        }))
        .filter((x) => x.vereinnahmt !== 0 || x.amazon_abgefuehrt !== 0);
      if (auslandListe.length > 0) auslandGesehen = true;

      return {
        monat,
        vereinnahmt: r2(vereinnahmt),
        amazon_abgefuehrt: r2(abgefuehrt),
        vorsteuer,
        zahllast_aus_amazon: vorsteuer === null
          ? null
          : r2(vereinnahmt - abgefuehrt - vorsteuer),
        ausland: auslandListe,
        ausland_summe: r2(auslandListe.reduce((s, a) => s + a.vereinnahmt, 0)),
        ausland_abgefuehrt: r2(auslandListe.reduce((s, a) => s + a.amazon_abgefuehrt, 0)),
        ausland_vorsteuer: auslandVorsteuer,
        je_marktplatz: jeMarktplatz,
      };
    });

  const hinweise: string[] = [];

  // Der wichtigste Vorbehalt zuerst. Ohne ihn liest sich die Zahl wie ein
  // Voranmeldungsergebnis, und das ist sie ausdrücklich nicht.
  hinweise.push(
    "Die Zahllast rechnet NUR mit Amazon-Daten. Vorsteuer aus Wareneinkauf, "
    + "Import, Logistik oder sonstigen Betriebsausgaben ist nicht enthalten — "
    + "die tatsächliche Zahllast liegt niedriger. Für die Liquiditätsplanung ist "
    + "das die vorsichtige Richtung, als Grundlage der Voranmeldung reicht es nicht.",
  );
  if (profil.faktor === null) {
    hinweise.push(
      "Ohne bestätigten Steuerfaktor bleibt die in den Bestellgebühren "
      + "eingerechnete Vorsteuer offen. Die Zahllast steht deshalb als „—“ statt "
      + "als geschätzte Zahl.",
    );
  }
  if (!profil.rhythmus) {
    hinweise.push(
      "Ohne hinterlegten Voranmeldungs-Rhythmus lässt sich nicht sagen, WANN die "
      + "Zahllast fällig wird. Der Betrag steht, der Termin fehlt.",
    );
  }
  // In Deutschland zahlt der Verkäufer selbst. Behält Amazon hier trotzdem
  // etwas ein, ist das die Ausnahme (etwa Ware aus dem Drittland) und gehört
  // erklärt, statt stillschweigend von der Schuld abgezogen zu werden.
  if (inlandEinbehalten > 0) {
    hinweise.push(
      `Amazon hat im Inland ${inlandEinbehalten.toFixed(2)} € Umsatzsteuer selbst `
      + "einbehalten und abgeführt. In Deutschland ist das die Ausnahme — normal "
      + "führt der Verkäufer selbst ab. Der Betrag ist von der Zahllast abgezogen; "
      + "bitte prüfen, ob er in die Voranmeldung gehört.",
    );
  }
  if (auslandGesehen && profil.oss !== true) {
    hinweise.push(
      "Es gibt Umsätze auf ausländischen Marktplätzen. Deren Steuer gehört nicht "
      + "in die deutsche Voranmeldung, sondern in die OSS-Meldung oder eine lokale "
      + "Registrierung. In den Stammdaten ist OSS "
      + (profil.oss === false ? "auf „nein“ gesetzt" : "nicht angegeben")
      + " — bitte prüfen.",
    );
  }
  if (auslandGesehen) {
    hinweise.push(
      "Die Trennung Inland/Ausland folgt dem MARKTPLATZ, nicht dem Bestimmungsland. "
      + "Ein Fernverkauf über Amazon.de an einen ausländischen Kunden trägt "
      + "ausländische Steuer und steht hier trotzdem im Inland.",
    );
  }

  return {
    monate,
    faellig_am: naechsteAnmeldung(profil.rhythmus, profil.dauerfrist === true, heute),
    rhythmus: profil.rhythmus,
    hinweise,
  };
}

/**
 * Welcher Zeitraum wird mit der Voranmeldung am `faellig_am` angemeldet?
 *
 * Nicht der laufende Monat. Die Anmeldung am 10.09. betrifft den AUGUST — und
 * genau das ging beim ersten Bau schief: der Kalender nahm den jüngsten Monat
 * mit Daten, also den angebrochenen September, und wies 0,00 € aus. Eine Null,
 * wo 5.450 € fällig sind, ist schlimmer als gar keine Zahl.
 *
 * Mit Dauerfristverlängerung verschiebt sich der Zeitraum um einen weiteren
 * Monat: die Anmeldung am 10.10. betrifft dann ebenfalls den August.
 */
export function angemeldeteMonate(
  faellig_am: string, rhythmus: string, dauerfrist: boolean,
): string[] {
  const j = Number(faellig_am.slice(0, 4));
  const m = Number(faellig_am.slice(5, 7)) - 1; // 0-basiert
  const versatz = dauerfrist ? 2 : 1;

  const alsText = (jahr: number, monat: number) => {
    const d = new Date(Date.UTC(jahr, monat, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  if (rhythmus === "monatlich") return [alsText(j, m - versatz)];
  if (rhythmus === "vierteljaehrlich") {
    // Der Termin liegt im Monat nach Quartalsende (plus Verlängerung). Von dort
    // aus rückwärts auf das Quartal, das gemeldet wird.
    const quartalsEnde = m - versatz;
    return [quartalsEnde - 2, quartalsEnde - 1, quartalsEnde].map((x) => alsText(j, x));
  }
  if (rhythmus === "jaehrlich") {
    const jahr = j - 1;
    return Array.from({ length: 12 }, (_, i) => alsText(jahr, i));
  }
  return [];
}

/**
 * Zahllast für den Zeitraum, der als Nächstes angemeldet wird.
 *
 * null, wenn für den Zeitraum keine Daten vorliegen — dann steht im Kalender
 * ein Termin ohne Betrag statt eines Betrags, den niemand geprüft hat.
 *
 * `fehlende` ist der wichtige Teil bei QUARTALSWEISER Anmeldung. Monatlich
 * meldet man einen Monat: er ist da oder nicht. Quartalsweise meldet man drei,
 * und wenn einer fehlt, summiert sich trotzdem eine plausibel aussehende Zahl
 * auf — ein Drittel zu niedrig, ohne dass irgendwas auffaellt. Genau so eine
 * Zahl ist schlimmer als gar keine, weil man danach disponiert.
 */
export function zahllastFuerTermin(
  monate: UstMonat[], faellig_am: string | null,
  rhythmus: string | null, dauerfrist: boolean,
): { betrag: number | null; zeitraum: string[]; fehlende: string[] } {
  if (!faellig_am || !rhythmus) return { betrag: null, zeitraum: [], fehlende: [] };
  const gesucht = angemeldeteMonate(faellig_am, rhythmus, dauerfrist);
  const treffer = monate.filter((m) => gesucht.includes(m.monat));
  const mitZahl = treffer.filter((m) => m.zahllast_aus_amazon !== null);
  const vorhanden = new Set(mitZahl.map((m) => m.monat));
  const fehlende = gesucht.filter((m) => !vorhanden.has(m));
  if (mitZahl.length === 0) return { betrag: null, zeitraum: gesucht, fehlende };
  return {
    betrag: r2(mitZahl.reduce((s, m) => s + (m.zahllast_aus_amazon ?? 0), 0)),
    zeitraum: gesucht,
    fehlende,
  };
}

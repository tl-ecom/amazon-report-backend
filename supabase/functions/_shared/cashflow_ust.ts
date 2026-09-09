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

export interface UstMonat {
  monat: string;
  vereinnahmt: number;
  /** Davon hat Amazon selbst abgeführt (Marketplace Facilitator). */
  amazon_abgefuehrt: number;
  /** Vorsteuer aus Amazon-Gebühren. null = Steuerfaktor nicht bestätigt. */
  vorsteuer: number | null;
  /** Was aus den Amazon-Daten ALLEIN übrig bleibt. Nicht die Zahllast. */
  zahllast_aus_amazon: number | null;
  ausland: Array<{ marktplatz: string; vereinnahmt: number }>;
  ausland_summe: number;
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

      const auslandListe = ausland
        .map((z) => ({ marktplatz: z.marktplatz, vereinnahmt: r2(z.vereinnahmt_cents / 100) }))
        .filter((x) => x.vereinnahmt !== 0);
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

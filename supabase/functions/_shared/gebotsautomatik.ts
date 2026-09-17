// gebotsautomatik.ts — aus Leistungsdaten ein Zielgebot je Keyword/Target rechnen.
//
// Reines Modul: kein Netz, keine DB. Die DB-Schicht liegt in
// gebotsautomatik_lauf.ts, der Schreibweg nach Amazon bleibt ads-gebote.
//
// Die Rechnung in einem Satz:
//
//     Max-CPC = Umsatz je Bestellung x Ziel-ACoS x CVR
//     Zielgebot = Max-CPC / (1 + gewichteter Platzierungs-Aufschlag)
//
// Zwei Dinge macht dieses Modul bewusst anders als die Automatik in Helium 10,
// weil genau daran deren Steuerung bei Vaneja gescheitert ist (17.09.2026):
//
// 1. PLATZIERUNGEN. Ein Gebot ist nicht der Preis, den man zahlt. Liegt auf
//    Top of Search ein Aufschlag von 70 %, kostet der Klick dort das 1,7-fache.
//    Wer nur das Basisgebot regelt, optimiert auf ein Ziel, das er nicht
//    erreichen kann. Deshalb teilt Schritt 2 durch den Aufschlag, gewichtet
//    mit dem tatsaechlichen Klick-Anteil je Platzierung.
//
// 2. DUENNE DATEN. Die meisten Ziele haben im Fenster eine einstellige
//    Klickzahl. Wer daraus je Ziel eine CVR schaetzt, rechnet Rauschen. Helium
//    10 hat in 12 Tagen sechs Gebote angehoben — alle sechs auf Zielen mit NULL
//    Klicks. Hier wird die CVR stattdessen zur Anzeigengruppe hin gezogen
//    (Beta-Binomial-Posterior mit Prior-Staerke PRIOR_KLICKS): ohne eigene
//    Daten gilt die Gruppe, mit vielen Daten das Ziel selbst, dazwischen ein
//    gleitender Uebergang.
//
// Alle Betraege in Euro. Amazons Untergrenze fuer SP-Gebote im EU-Raum ist 0,02.

export const MIN_GEBOT_AMAZON = 0.02;

/**
 * Prior-Staerke der CVR-Schaetzung, in Klicks.
 *
 * Ein Ziel mit genau so vielen Klicks wie PRIOR_KLICKS bekommt eine CVR je zur
 * Haelfte aus eigenen Daten und aus der Gruppe. 15 ist bewusst hoch gewaehlt:
 * bei ~15 % CVR braucht es rund 15 Klicks, bis ueberhaupt eine Bestellung zu
 * erwarten ist. Kleiner eingestellt faengt das Modul an, Einzelklicks zu
 * interpretieren — genau der Fehler, den es vermeiden soll.
 */
export const PRIOR_KLICKS = 15;

/**
 * Totzone in Euro. Aenderungen darunter werden nicht vorgeschlagen.
 *
 * Amazon braucht nach jeder Gebotsaenderung Zeit, bis sich die Auslieferung
 * einpendelt. Ein Vorschlag ueber 1 Cent kostet diese Einschwingzeit, ohne
 * etwas zu bewirken.
 */
export const TOTZONE = 0.03;

export interface Regel {
  campaign_id: string;
  /** Anteil, nicht Prozent: 0.30 = 30 %. */
  ziel_acos: number;
  min_gebot: number;
  max_gebot: number;
  /** Groesster erlaubter Sprung je Lauf, in Prozent. */
  max_schritt_prozent: number;
  /** Ab so vielen Klicks gilt ein Ziel als belastbar. */
  min_klicks: number;
}

export interface ZielLeistung {
  art: "keyword" | "target";
  ziel_id: string;
  campaign_id: string;
  ad_group_id: string;
  text: string | null;
  match_type: string | null;
  state: string | null;
  /** null = erbt das Standardgebot der Anzeigengruppe. */
  gebot: number | null;
  klicks: number;
  bestellungen: number;
  umsatz: number;
}

export interface GruppenLeistung {
  ad_group_id: string;
  klicks: number;
  bestellungen: number;
  umsatz: number;
}

/** Eine Platzierung mit ihrem Klick-Anteil und dem gesetzten Aufschlag. */
export interface PlatzierungsAnteil {
  platzierung: string;
  klicks: number;
  /** Aufschlag als Anteil: 0.5 = +50 %. */
  modifikator: number;
}

export type Aktion =
  | "senken" | "erhoehen" | "unveraendert"
  | "keine_daten" | "erbt_gruppengebot" | "nicht_aktiv";

export interface Vorschlag {
  art: "keyword" | "target";
  ziel_id: string;
  campaign_id: string;
  ad_group_id: string;
  text: string | null;
  match_type: string | null;
  gebot_alt: number | null;
  gebot_neu: number | null;
  aktion: Aktion;
  begruendung: string;
  klicks: number;
  bestellungen: number;
  cvr_eigen: number | null;
  cvr_gruppe: number | null;
  cvr_genutzt: number | null;
  umsatz_je_bestellung: number | null;
  max_cpc: number | null;
  aufschlag_gewichtet: number;
  /** true, wenn das Ziel die Klickschwelle der Regel selbst erreicht. */
  belastbar: boolean;
}

const rund = (x: number, stellen = 2) =>
  Math.round(x * 10 ** stellen) / 10 ** stellen;

/**
 * Gewichteter Platzierungs-Aufschlag einer Kampagne.
 *
 * Gewichtet wird mit Klicks, nicht gleichverteilt: laeuft der Grossteil der
 * Klicks ueber Top of Search, zaehlt dessen Aufschlag entsprechend schwerer.
 * Ohne Klickdaten kommt 0 zurueck — dann wirkt Schritt 2 der Rechnung nicht,
 * was die konservative Richtung ist (Zielgebot bleibt der Max-CPC).
 */
export function gewichteterAufschlag(anteile: PlatzierungsAnteil[]): number {
  const gesamt = anteile.reduce((s, a) => s + Math.max(0, a.klicks), 0);
  if (gesamt <= 0) return 0;
  const summe = anteile.reduce(
    (s, a) => s + (Math.max(0, a.klicks) / gesamt) * a.modifikator,
    0,
  );
  return rund(summe, 4);
}

/**
 * CVR eines Ziels, zur Anzeigengruppe hin gezogen.
 *
 * Posterior-Mittel einer Beta-Binomial-Schaetzung: der Prior sitzt auf der
 * Gruppen-CVR und wiegt PRIOR_KLICKS Klicks schwer.
 */
export function geschaetzteCvr(
  ziel: { klicks: number; bestellungen: number },
  gruppe: { klicks: number; bestellungen: number },
  prior = PRIOR_KLICKS,
): { eigen: number | null; gruppe: number | null; genutzt: number | null } {
  const cvrGruppe = gruppe.klicks > 0 ? gruppe.bestellungen / gruppe.klicks : null;
  const cvrEigen = ziel.klicks > 0 ? ziel.bestellungen / ziel.klicks : null;
  if (cvrGruppe === null) {
    // Keine Gruppendaten: nur die eigenen, wenn es welche gibt.
    return { eigen: cvrEigen, gruppe: null, genutzt: cvrEigen };
  }
  const genutzt = (ziel.bestellungen + prior * cvrGruppe) / (ziel.klicks + prior);
  return {
    eigen: cvrEigen === null ? null : rund(cvrEigen, 4),
    gruppe: rund(cvrGruppe, 4),
    genutzt: rund(genutzt, 4),
  };
}

/**
 * Umsatz je Bestellung. Eigene Zahl des Ziels nur, wenn es Bestellungen hat,
 * sonst die der Gruppe — ein einzelner Mehrstueck-Kauf wuerde sonst den Wert
 * eines Ziels verdoppeln und sein Gebot mit hochziehen.
 */
export function umsatzJeBestellung(
  ziel: { bestellungen: number; umsatz: number },
  gruppe: { bestellungen: number; umsatz: number },
): number | null {
  if (gruppe.bestellungen > 0) return rund(gruppe.umsatz / gruppe.bestellungen);
  if (ziel.bestellungen > 0) return rund(ziel.umsatz / ziel.bestellungen);
  return null;
}

/** Ergebnis in die Klammer der Regel zwingen: Schrittweite, dann Min/Max. */
export function klemme(
  alt: number, gewuenscht: number, regel: Regel,
): { wert: number; gekappt: string | null } {
  let gekappt: string | null = null;
  let wert = gewuenscht;

  const grenze = regel.max_schritt_prozent / 100;
  const obenSchritt = alt * (1 + grenze);
  const untenSchritt = alt * (1 - grenze);
  if (wert > obenSchritt) { wert = obenSchritt; gekappt = `Schrittweite ${regel.max_schritt_prozent} %`; }
  if (wert < untenSchritt) { wert = untenSchritt; gekappt = `Schrittweite ${regel.max_schritt_prozent} %`; }

  const untergrenze = Math.max(regel.min_gebot, MIN_GEBOT_AMAZON);
  if (wert > regel.max_gebot) { wert = regel.max_gebot; gekappt = `Obergrenze ${regel.max_gebot.toFixed(2)} EUR`; }
  if (wert < untergrenze) { wert = untergrenze; gekappt = `Untergrenze ${untergrenze.toFixed(2)} EUR`; }

  return { wert: rund(wert), gekappt };
}

/** Einen Vorschlag fuer genau ein Ziel rechnen. */
export function berechneVorschlag(
  ziel: ZielLeistung,
  gruppe: GruppenLeistung | undefined,
  aufschlag: number,
  regel: Regel,
): Vorschlag {
  const basis = {
    art: ziel.art, ziel_id: ziel.ziel_id, campaign_id: ziel.campaign_id,
    ad_group_id: ziel.ad_group_id, text: ziel.text, match_type: ziel.match_type,
    gebot_alt: ziel.gebot, klicks: ziel.klicks, bestellungen: ziel.bestellungen,
    aufschlag_gewichtet: aufschlag,
    belastbar: ziel.klicks >= regel.min_klicks,
  };
  const leer = {
    ...basis, gebot_neu: null, cvr_eigen: null, cvr_gruppe: null,
    cvr_genutzt: null, umsatz_je_bestellung: null, max_cpc: null,
  };

  if ((ziel.state ?? "").toUpperCase() !== "ENABLED") {
    return { ...leer, aktion: "nicht_aktiv", begruendung: `Zustand ${ziel.state ?? "unbekannt"} — nicht angefasst.` };
  }
  if (ziel.gebot === null) {
    return {
      ...leer, aktion: "erbt_gruppengebot",
      begruendung: "Erbt das Standardgebot der Anzeigengruppe. Ein Zielgebot waere hier eine neue Entscheidung, keine Korrektur.",
    };
  }

  const g = gruppe ?? { ad_group_id: ziel.ad_group_id, klicks: 0, bestellungen: 0, umsatz: 0 };
  const cvr = geschaetzteCvr(ziel, g);
  const ujb = umsatzJeBestellung(ziel, g);

  if (cvr.genutzt === null || cvr.genutzt <= 0 || ujb === null || ujb <= 0) {
    return {
      ...leer, cvr_eigen: cvr.eigen, cvr_gruppe: cvr.gruppe, cvr_genutzt: cvr.genutzt,
      umsatz_je_bestellung: ujb, aktion: "keine_daten",
      begruendung: "Weder das Ziel noch seine Anzeigengruppe hat im Fenster eine Bestellung. Ohne CVR und Umsatz je Bestellung gibt es keinen tragfaehigen CPC — Gebot bleibt, wo es ist.",
    };
  }

  const maxCpc = rund(ujb * regel.ziel_acos * cvr.genutzt);
  const gewuenscht = maxCpc / (1 + aufschlag);
  const { wert, gekappt } = klemme(ziel.gebot, gewuenscht, regel);

  const gemein = {
    ...basis, cvr_eigen: cvr.eigen, cvr_gruppe: cvr.gruppe, cvr_genutzt: cvr.genutzt,
    umsatz_je_bestellung: ujb, max_cpc: maxCpc,
  };

  if (Math.abs(wert - ziel.gebot) < TOTZONE) {
    return {
      ...gemein, gebot_neu: null, aktion: "unveraendert",
      begruendung: `Zielgebot ${wert.toFixed(2)} EUR liegt weniger als ${TOTZONE.toFixed(2)} EUR vom aktuellen entfernt — nicht anfassen.`,
    };
  }

  const quelle = gemein.belastbar
    ? `${ziel.klicks} Klicks am Ziel`
    : `nur ${ziel.klicks} Klicks am Ziel, CVR ueberwiegend aus der Anzeigengruppe`;
  const aufschlagText = aufschlag > 0
    ? ` Platzierungs-Aufschlag ${(aufschlag * 100).toFixed(0)} % herausgerechnet.`
    : "";
  const kappText = gekappt ? ` Gekappt durch ${gekappt}.` : "";

  return {
    ...gemein, gebot_neu: wert,
    aktion: wert < ziel.gebot ? "senken" : "erhoehen",
    begruendung:
      `Max-CPC ${maxCpc.toFixed(2)} EUR = ${ujb.toFixed(2)} EUR je Bestellung x ` +
      `${(regel.ziel_acos * 100).toFixed(0)} % Ziel-ACoS x ${(cvr.genutzt * 100).toFixed(1)} % CVR ` +
      `(${quelle}).${aufschlagText}${kappText}`,
  };
}

/** Alle Ziele einer Kampagne durchrechnen. */
export function berechneVorschlaege(
  ziele: ZielLeistung[],
  gruppen: GruppenLeistung[],
  platzierungen: PlatzierungsAnteil[],
  regel: Regel,
): Vorschlag[] {
  const proGruppe = new Map(gruppen.map((g) => [g.ad_group_id, g]));
  const aufschlag = gewichteterAufschlag(platzierungen);
  return ziele
    .filter((z) => z.campaign_id === regel.campaign_id)
    .map((z) => berechneVorschlag(z, proGruppe.get(z.ad_group_id), aufschlag, regel));
}

/** Kurze Bilanz eines Laufs fuer die Antwort der Function. */
export function bilanz(vorschlaege: Vorschlag[]) {
  const z = (a: Aktion) => vorschlaege.filter((v) => v.aktion === a).length;
  const aenderungen = vorschlaege.filter((v) => v.gebot_neu !== null);
  const summeAlt = aenderungen.reduce((s, v) => s + (v.gebot_alt ?? 0), 0);
  const summeNeu = aenderungen.reduce((s, v) => s + (v.gebot_neu ?? 0), 0);
  return {
    gesamt: vorschlaege.length,
    senken: z("senken"),
    erhoehen: z("erhoehen"),
    unveraendert: z("unveraendert"),
    keine_daten: z("keine_daten"),
    erbt_gruppengebot: z("erbt_gruppengebot"),
    nicht_aktiv: z("nicht_aktiv"),
    belastbar: vorschlaege.filter((v) => v.belastbar).length,
    summe_gebote_alt: rund(summeAlt),
    summe_gebote_neu: rund(summeNeu),
  };
}

// cashflow.ts — Geldfluss innerhalb von Amazon. NICHT Gewinn.
//
// Beides wird gern verwechselt, und die Verwechslung ist teuer: ein Konto mit
// 20 % Marge kann trotzdem klemmen, weil zwischen Wareneinkauf und Auszahlung
// drei Wochen liegen. Dieses Modul beantwortet nur Fragen der Art "wann kommt
// welches Geld an und wann geht welches weg" — und zwar aus dem, was Amazon
// TATSAECHLICH gebucht hat, nicht aus Amazons Hilfetexten.
//
// Warum gemessen und nicht angenommen: "Auszahlung alle 14 Tage" stimmt als
// Faustregel, sagt aber nichts ueber den Schnitt. Der Settlement-Bericht nennt
// ihn auf die Sekunde. Bei Vaneja liegt er ueber Monate hinweg bei 15:44 UTC,
// und die Auszahlung folgt exakt 48 Stunden spaeter. Das ist keine Regel, die
// man raten koennte, und sie ist je Konto verschieden.
//
// Die Ableitungen hier sind rein und ohne Datenbank, damit sie getestet werden
// koennen. Die DB-Schicht steht ganz unten.

import { ladeUstFaktor } from "./ust_lauf.ts";

// --- Bausteine --------------------------------------------------------------

/** Median statt Mittelwert: Ein einzelnes Sonder-Settlement ueber 868 Tage
 *  (die gibt es wirklich) wuerde jeden Mittelwert unbrauchbar machen. */
export function median(werte: number[]): number | null {
  const xs = werte.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

function tageZwischen(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export interface Auszahlung {
  settlement_id: string;
  von: string | null;
  bis: string | null;
  auszahlung_am: string | null;
  betrag_cents: number | null;
  /** ISO-Zeitstempel aus dem Rohbericht. null = das Format war unbekannt. */
  bis_utc?: string | null;
  auszahlung_utc?: string | null;
}

export interface Rhythmus {
  periode_tage: number | null;
  /** Abstand Periodenende -> Auszahlung. In Stunden, weil er es genau ist. */
  verzug_stunden: number | null;
  /** Uhrzeit des Periodenschnitts in der Zeitzone des Lesers. null = unbekannt. */
  schnitt_uhrzeit: string | null;
  /** Auf wie vielen Abrechnungen die Messung beruht. */
  belege: number;
  naechste: Array<{ periode_bis: string; auszahlung_am: string; geschaetzt: boolean }>;
}

const ZEITZONE = "Europe/Berlin";

function uhrzeit(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit", minute: "2-digit", timeZone: ZEITZONE,
  }).format(new Date(iso));
}

/**
 * Auszahlungsrhythmus aus den tatsaechlichen Abrechnungen.
 *
 * Amazon fuehrt mehrere Abrechnungsreihen parallel (eine traegt den Umsatz,
 * daneben laufen kleine Sonderreihen fuer Nachzuegler). Deshalb wird die Reihe
 * mit dem groessten Umsatz als Hauptreihe genommen — die kleinen wuerden den
 * Rhythmus sonst zerfasern.
 */
export function auszahlungsRhythmus(alle: Auszahlung[], heute = new Date()): Rhythmus {
  const brauchbar = alle.filter((a) => a.von && a.bis && a.auszahlung_am);
  if (brauchbar.length === 0) {
    return { periode_tage: null, verzug_stunden: null, schnitt_uhrzeit: null, belege: 0, naechste: [] };
  }

  // Hauptreihe: Abrechnungen mit Geldbewegung. Die Null-Abrechnungen sind
  // formale Abschluesse ohne Zahlung und sagen ueber den Rhythmus nichts.
  const mitGeld = brauchbar.filter((a) => Math.abs(Number(a.betrag_cents) || 0) > 0);
  const reihe = mitGeld.length >= 3 ? mitGeld : brauchbar;

  const periode = median(reihe.map((a) => tageZwischen(a.von!, a.bis!)));

  // Verzug: erst in Stunden aus den Rohzeitstempeln, sonst in Tagen aus den
  // Datumsspalten. Zwei Genauigkeiten, aber nie eine erfundene.
  const stundenGenau = median(
    reihe.filter((a) => a.bis_utc && a.auszahlung_utc)
      .map((a) => (Date.parse(a.auszahlung_utc!) - Date.parse(a.bis_utc!)) / 3600000),
  );
  const tageGrob = median(reihe.map((a) => tageZwischen(a.bis!, a.auszahlung_am!)));
  const verzugStunden = stundenGenau ?? (tageGrob === null ? null : tageGrob * 24);

  // Der Schnitt ist nur dann eine Aussage, wenn er sich wiederholt. Eine
  // einzelne Uhrzeit waere Zufall.
  const zeitstempel = reihe.map((a) => a.bis_utc).filter((x): x is string => Boolean(x));
  const zeiten = zeitstempel.map(uhrzeit);
  const haeufigste = zeiten.reduce<Record<string, number>>((acc, z) => {
    acc[z] = (acc[z] ?? 0) + 1;
    return acc;
  }, {});
  const [beste, anzahl] = Object.entries(haeufigste)
    .sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const schnitt = anzahl >= 3 ? beste : null;

  // Fortschreibung: vom juengsten Periodenende der Hauptreihe aus.
  const naechste: Rhythmus["naechste"] = [];
  const juengste = reihe.slice().sort((a, b) => Date.parse(b.bis!) - Date.parse(a.bis!))[0];
  if (juengste && periode && verzugStunden !== null) {
    let ende = Date.parse(juengste.bis_utc ?? `${juengste.bis!}T12:00:00Z`);
    // Die juengste Abrechnung ist bereits gelaufen; ihre Auszahlung kann aber
    // noch bevorstehen. Dann ist SIE der naechste Termin, nicht die Prognose.
    const ersteZahlung = ende + verzugStunden * 3600000;
    if (ersteZahlung > heute.getTime()) {
      naechste.push({
        periode_bis: new Date(ende).toISOString(),
        auszahlung_am: new Date(ersteZahlung).toISOString(),
        geschaetzt: false,
      });
    }
    for (let i = 0; i < 3; i++) {
      ende += periode * 86400000;
      naechste.push({
        periode_bis: new Date(ende).toISOString(),
        auszahlung_am: new Date(ende + verzugStunden * 3600000).toISOString(),
        geschaetzt: true,
      });
    }
  }

  return {
    periode_tage: periode,
    verzug_stunden: verzugStunden === null ? null : r2(verzugStunden),
    schnitt_uhrzeit: schnitt,
    belege: reihe.length,
    naechste,
  };
}

// --- Terminbuchungen --------------------------------------------------------

export interface TerminZeile { art: string; gebucht_am: string; betrag_cents: number }

export interface TerminMuster {
  art: string;
  /** Tag im Monat, an dem gebucht wird. null = kein wiederkehrender Tag. */
  tag_im_monat: number | null;
  /** Wie oft dieser Tag in den Belegen vorkam, von wie vielen. */
  belege: number;
  treffer: number;
  letzte_buchung: string | null;
  letzter_betrag: number | null;
  schnitt_betrag: number | null;
}

/**
 * Terminbuchungen (Lagergebuehr, Langzeitlagergebuehr, Kontogebuehr) auf einen
 * Tag im Monat zurueckfuehren. `treffer < belege` heisst: der Tag schwankt, die
 * Prognose ist entsprechend weich — das steht in der Ausgabe und wird nicht
 * weggerundet.
 */
export function terminMuster(zeilen: TerminZeile[]): TerminMuster[] {
  const nachArt = new Map<string, TerminZeile[]>();
  for (const z of zeilen) {
    const liste = nachArt.get(z.art) ?? [];
    liste.push(z);
    nachArt.set(z.art, liste);
  }

  return [...nachArt.entries()].map(([art, liste]) => {
    const sortiert = liste.slice().sort((a, b) => b.gebucht_am.localeCompare(a.gebucht_am));
    const tage = sortiert.map((z) => Number(z.gebucht_am.slice(8, 10)));
    const m = median(tage);
    const tag = m === null ? null : Math.round(m);
    const treffer = tag === null ? 0 : tage.filter((t) => Math.abs(t - tag) <= 1).length;
    const betraege = sortiert.map((z) => Math.abs(Number(z.betrag_cents) || 0) / 100);
    return {
      art,
      // Ein Tag, der nur die Haelfte der Belege trifft, ist kein Termin.
      tag_im_monat: tag !== null && treffer >= Math.ceil(sortiert.length / 2) ? tag : null,
      belege: sortiert.length,
      treffer,
      letzte_buchung: sortiert[0]?.gebucht_am ?? null,
      letzter_betrag: betraege[0] !== undefined ? r2(-betraege[0]) : null,
      schnitt_betrag: median(betraege) === null ? null : r2(-(median(betraege) as number)),
    };
  }).sort((a, b) => (a.tag_im_monat ?? 99) - (b.tag_im_monat ?? 99));
}

// --- Werbekosten ------------------------------------------------------------

export interface WerbungZeile { gebucht_am: string; betrag_cents: number }

export interface WerbungMuster {
  art: "rechnungsschwelle" | "unregelmaessig" | "zu_wenig_daten";
  /** Bei Rechnungsschwelle: die Hoehe, ab der Amazon abbucht. */
  schwelle: number | null;
  abstand_tage_median: number | null;
  buchungen: number;
  summe: number | null;
  je_tag: number | null;
}

const SCHWELLE_TOLERANZ = 0.10;

/**
 * Werbekosten laufen nicht ueber den Auszahlungstermin. Amazon bucht sie
 * laufend ab — bei Vaneja gemessen: 42 Buchungen in zwei Monaten, fast alle
 * zwischen 595 und 606 €, Abstand ein bis zwei Tage. Das ist keine Frequenz,
 * das ist eine RECHNUNGSSCHWELLE: Amazon bucht, sobald ein Betrag erreicht ist.
 *
 * Der Unterschied ist fuer die Planung wesentlich. Wer die Werbung als
 * Monatsposten einplant, verschaetzt sich um Wochen; wer die Schwelle kennt,
 * weiss, dass mehr Werbebudget SOFORT mehr Abfluss bedeutet, nicht spaeter.
 */
export function werbungsMuster(zeilen: WerbungZeile[]): WerbungMuster {
  const sortiert = zeilen.slice().sort((a, b) => a.gebucht_am.localeCompare(b.gebucht_am));
  const betraege = sortiert.map((z) => Math.abs(Number(z.betrag_cents) || 0) / 100);
  const summe = betraege.reduce((s, b) => s + b, 0);

  if (sortiert.length < 5) {
    return {
      art: "zu_wenig_daten", schwelle: null, abstand_tage_median: null,
      buchungen: sortiert.length, summe: sortiert.length ? r2(-summe) : null, je_tag: null,
    };
  }

  const abstaende: number[] = [];
  for (let i = 1; i < sortiert.length; i++) {
    abstaende.push(tageZwischen(sortiert[i - 1].gebucht_am, sortiert[i].gebucht_am));
  }
  const spanneTage = tageZwischen(sortiert[0].gebucht_am, sortiert[sortiert.length - 1].gebucht_am) || 1;

  // Schwelle liegt vor, wenn die BETRAEGE eng beieinander liegen. Bei einem
  // Termin waeren die Betraege verschieden und die Abstaende gleich — hier ist
  // es umgekehrt.
  const typisch = median(betraege) as number;
  const nahDran = betraege.filter((b) => Math.abs(b - typisch) <= typisch * SCHWELLE_TOLERANZ).length;
  const istSchwelle = nahDran >= sortiert.length * 0.8;

  return {
    art: istSchwelle ? "rechnungsschwelle" : "unregelmaessig",
    schwelle: istSchwelle ? r2(typisch) : null,
    abstand_tage_median: median(abstaende),
    buchungen: sortiert.length,
    summe: r2(-summe),
    je_tag: r2(-(summe / spanneTage)),
  };
}

// --- Einbehalt --------------------------------------------------------------

export interface ReserveZeile { gebucht_am: string; art: string; betrag_cents: number }

export interface ReserveStand {
  stand: number | null;
  stand_am: string | null;
  /** Anteil des Einbehalts am letzten Auszahlungsbetrag, in Prozent. */
  anteil_prozent: number | null;
  belege: number;
}

/**
 * "Current Reserve Amount" ist der Betrag, den Amazon bei DIESER Abrechnung
 * zurueckhaelt; "Previous Reserve Amount Balance" gibt den der Vorperiode
 * wieder frei. Der aktuelle Einbehalt ist also der Betrag der juengsten
 * Current-Zeile, nicht die Summe aller Zeilen.
 */
export function reserveStand(zeilen: ReserveZeile[], letzteAuszahlung: number | null): ReserveStand {
  const aktuell = zeilen
    .filter((z) => z.art === "Current Reserve Amount")
    .sort((a, b) => b.gebucht_am.localeCompare(a.gebucht_am));
  if (aktuell.length === 0) {
    return { stand: null, stand_am: null, anteil_prozent: null, belege: 0 };
  }
  const stand = Math.abs(Number(aktuell[0].betrag_cents) || 0) / 100;
  const basis = letzteAuszahlung === null ? null : Math.abs(letzteAuszahlung);
  return {
    stand: r2(stand),
    stand_am: aktuell[0].gebucht_am,
    anteil_prozent: basis && basis > 0 ? Math.round((stand / basis) * 1000) / 10 : null,
    belege: aktuell.length,
  };
}

// --- Gebundenes Geld --------------------------------------------------------

export interface MonatZeile {
  monat: string; bestellungen: number; offen_anzahl: number; offen_cents: number;
}

export interface Gebunden {
  betrag: number | null;
  ab_monat: string | null;
  /** Monate, die zu grosse Luecken haben, um als "unterwegs" zu gelten. */
  luecken: string[];
  hinweis: string | null;
}

/** Ab hier gilt ein Monat als abgerechnet. Darunter ist er entweder frisch
 *  oder es fehlen die Berichte — beides ist nicht "Geld unterwegs". */
const ABGERECHNET_SCHWELLE = 0.10;

/**
 * Geld, das Amazon schon eingenommen hat und der Verkaeufer noch nicht sieht.
 *
 * Die Falle: einfach alle Bestellungen ohne Abrechnungszeile zu summieren.
 * Bei Vaneja kam so 38.978 € heraus — darin steckte der April, der zu 90 %
 * ohne Abrechnungszeile ist, weil die Settlement-Berichte nicht so weit
 * zurueckreichen. Eine Datenluecke als Guthaben auszuweisen ist schlimmer als
 * gar keine Zahl.
 *
 * Deshalb: vom juengsten Monat rueckwaerts bis zum letzten Monat, der
 * nachweislich abgerechnet IST. Was davor noch offen ist, ist eine Luecke und
 * wird getrennt gemeldet.
 */
export function gebundenesGeld(monate: MonatZeile[]): Gebunden {
  const sortiert = monate.slice().sort((a, b) => a.monat.localeCompare(b.monat));
  if (sortiert.length === 0) return { betrag: null, ab_monat: null, luecken: [], hinweis: null };

  const anteil = (m: MonatZeile) => (m.bestellungen > 0 ? m.offen_anzahl / m.bestellungen : 1);

  // Von hinten den letzten Monat suchen, der abgerechnet ist. Alles danach ist
  // unterwegs.
  let grenze = -1;
  for (let i = sortiert.length - 1; i >= 0; i--) {
    if (anteil(sortiert[i]) < ABGERECHNET_SCHWELLE) { grenze = i; break; }
  }
  if (grenze === -1) {
    return {
      betrag: null, ab_monat: null,
      luecken: sortiert.map((m) => m.monat),
      hinweis: "Kein Monat im Fenster ist vollständig abgerechnet — der gebundene "
        + "Betrag lässt sich nicht von einer Lücke in den Abrechnungsberichten trennen.",
    };
  }

  const unterwegs = sortiert.slice(grenze);
  const betrag = unterwegs.reduce((s, m) => s + (Number(m.offen_cents) || 0), 0) / 100;
  const luecken = sortiert.slice(0, grenze)
    .filter((m) => anteil(m) >= ABGERECHNET_SCHWELLE)
    .map((m) => m.monat);

  return {
    betrag: r2(betrag),
    ab_monat: unterwegs[0]?.monat ?? null,
    luecken,
    hinweis: luecken.length
      ? `Für ${luecken.join(", ")} fehlen Abrechnungszeilen, obwohl der Zeitraum `
        + "längst abgerechnet sein müsste. Das ist eine Lücke in der Berichtshistorie "
        + "und NICHT im gebundenen Betrag enthalten."
      : null,
  };
}

// --- Vorsteuer --------------------------------------------------------------

export interface VorsteuerZeile {
  monat: string;
  /** Von Amazon separat ausgewiesen ("Tax on fee"), negativ. */
  ausgewiesen_cents: number | null;
  /** Bestellgebuehren brutto, negativ. Die Steuer steckt darin. */
  in_gebuehren_cents: number | null;
}

export interface VorsteuerMonat {
  monat: string;
  ausgewiesen: number | null;
  aus_gebuehren: number | null;
  gesamt: number | null;
}

export interface Vorsteuer {
  monate: VorsteuerMonat[];
  /** Wann die naechste Voranmeldung faellig ist. null = Rhythmus nicht hinterlegt. */
  naechste_anmeldung: string | null;
  rhythmus: string | null;
  abzugsberechtigt: boolean | null;
  hinweise: string[];
}

/**
 * Vorsteuer aus den Amazon-Gebuehren.
 *
 * Amazon weist sie auf zwei Arten aus, und die Ausgabe haelt beide getrennt:
 *   - Kontogebuehren (Lager, Transport, Coupon): eigene Zeile "Tax on fee".
 *     Ablesbar, kein Rechnen noetig.
 *   - Bestellgebuehren (Provision, FBA): Steuer ist EINGERECHNET. An einer
 *     Bestellung nachgerechnet: 44,97 € brutto x 15 % = 6,75 € netto, gebucht
 *     wurden 8,03 € = 6,75 x 1,19. Sie muss herausgerechnet werden, und dafuer
 *     braucht es den Steuerfaktor der Firma.
 *
 * Ohne Vorsteuerabzug (Kleinunternehmer) kommt gar nichts zurueck — dann
 * stehen hier Nullen, aber mit Begruendung statt stillschweigend.
 */
export function vorsteuer(
  zeilen: VorsteuerZeile[],
  profil: {
    faktor: number | null;
    abzugsberechtigt: boolean | null;
    rhythmus: string | null;
    dauerfrist: boolean | null;
  },
  heute = new Date(),
): Vorsteuer {
  const hinweise: string[] = [];

  const monate: VorsteuerMonat[] = zeilen
    .slice().sort((a, b) => b.monat.localeCompare(a.monat))
    .map((z) => {
      const ausgewiesen = z.ausgewiesen_cents === null
        ? null
        : r2(Math.abs(Number(z.ausgewiesen_cents)) / 100);
      // Aus dem Bruttobetrag den Steueranteil: brutto - brutto/faktor.
      const brutto = z.in_gebuehren_cents === null ? null : Math.abs(Number(z.in_gebuehren_cents));
      const ausGebuehren = brutto === null || profil.faktor === null
        ? null
        : r2((brutto - brutto / profil.faktor) / 100);
      const gesamt = ausgewiesen === null && ausGebuehren === null
        ? null
        : r2((ausgewiesen ?? 0) + (ausGebuehren ?? 0));
      return { monat: z.monat, ausgewiesen, aus_gebuehren: ausGebuehren, gesamt };
    });

  if (profil.faktor === null) {
    hinweise.push(
      "Für die Bestellgebühren ist kein Steuerfaktor bestätigt. Die darin "
      + "enthaltene Vorsteuer bleibt deshalb offen (—) statt geschätzt zu werden.",
    );
  }
  if (profil.abzugsberechtigt === false) {
    hinweise.push(
      "Als Kleinunternehmer (§ 19 UStG) gibt es keinen Vorsteuerabzug — die "
      + "Umsatzsteuer in den Amazon-Gebühren ist endgültige Kosten, kein "
      + "durchlaufender Posten.",
    );
  }
  if (profil.abzugsberechtigt === null) {
    hinweise.push(
      "Ob die Firma vorsteuerabzugsberechtigt ist, steht nicht in den "
      + "Stammdaten. Ohne diese Angabe ist offen, ob die Beträge zurückkommen.",
    );
  }
  if (!profil.rhythmus) {
    hinweise.push(
      "Der Rhythmus der Umsatzsteuer-Voranmeldung ist nicht hinterlegt. Damit "
      + "lässt sich nicht sagen, WANN die Vorsteuer zurückfließt.",
    );
  }

  return {
    monate,
    naechste_anmeldung: naechsteAnmeldung(profil.rhythmus, profil.dauerfrist === true, heute),
    rhythmus: profil.rhythmus,
    abzugsberechtigt: profil.abzugsberechtigt,
    hinweise,
  };
}

/**
 * Naechster Abgabetermin der Voranmeldung: der 10. nach Ablauf des Zeitraums,
 * bei Dauerfristverlaengerung einen Monat spaeter.
 *
 * Bewusst der ABGABE-Termin und nicht der Erstattungstag: wann das Finanzamt
 * auszahlt, haengt vom Amt ab und steht in keinen Daten, die Pulse hat. Eine
 * Zahl dafuer waere geraten.
 */
export function naechsteAnmeldung(
  rhythmus: string | null, dauerfrist: boolean, heute = new Date(),
): string | null {
  if (!rhythmus || rhythmus === "keine") return null;
  const j = heute.getUTCFullYear();
  const m = heute.getUTCMonth(); // 0-basiert

  const faellig = (jahr: number, monat: number): Date =>
    new Date(Date.UTC(jahr, monat + (dauerfrist ? 1 : 0), 10));

  const kandidaten: Date[] = [];
  if (rhythmus === "monatlich") {
    for (let i = 0; i <= 3; i++) kandidaten.push(faellig(j, m + i));
  } else if (rhythmus === "vierteljaehrlich") {
    for (let q = 0; q <= 4; q++) kandidaten.push(faellig(j, (Math.floor(m / 3) + q) * 3));
  } else if (rhythmus === "jaehrlich") {
    // Jahreserklaerung: nicht der 10., sondern der 31.07. des Folgejahres.
    for (let i = 0; i <= 1; i++) kandidaten.push(new Date(Date.UTC(j + i, 6, 31)));
  }

  const naechst = kandidaten.filter((d) => d.getTime() > heute.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return naechst ? naechst.toISOString().slice(0, 10) : null;
}

// --- DB-Schicht -------------------------------------------------------------

export interface CashflowArgs { tage?: unknown }

export async function cashflowUebersicht(
  supabase: any, tenant_id: string, args: CashflowArgs = {},
): Promise<unknown> {
  const tage = Math.min(365, Math.max(30, Number(args.tage) || 120));

  const [basisRes, zeitRes, faktor, stammRes] = await Promise.all([
    supabase.rpc("cashflow_basis", { p_tenant: tenant_id, p_tage: tage }),
    supabase.rpc("cashflow_zeitpunkte", { p_tenant: tenant_id, p_tage: tage }),
    ladeUstFaktor(supabase, tenant_id),
    supabase.from("tenant_einstellungen")
      .select("umsatzsteuerpflichtig, vorsteuerabzug, ust_voranmeldung, "
        + "ust_dauerfristverlaengerung, ermaessigter_satz, oss_teilnahme, pan_eu, "
        + "lager_ausland, lager_laender, stammdaten_bestaetigt_am")
      .eq("tenant_id", tenant_id).maybeSingle(),
  ]);
  if (basisRes.error) throw new Error(`cashflow_basis: ${basisRes.error.message}`);

  const basis = (basisRes.data ?? {}) as any;
  const stamm = stammRes?.data ?? {};

  // Zeitstempel an die Abrechnungen heften. Ohne sie bleibt der Rhythmus
  // tagesgenau statt sekundengenau — nutzbar, aber weniger.
  const zeiten = new Map<string, { bis: string | null; aus: string | null }>();
  for (const z of (zeitRes?.data ?? []) as any[]) {
    zeiten.set(String(z.settlement_id), { bis: z.bis_utc ?? null, aus: z.auszahlung_utc ?? null });
  }
  const auszahlungen: Auszahlung[] = ((basis.auszahlungen ?? []) as any[]).map((a) => ({
    ...a,
    bis_utc: zeiten.get(String(a.settlement_id))?.bis ?? null,
    auszahlung_utc: zeiten.get(String(a.settlement_id))?.aus ?? null,
  }));

  const rhythmus = auszahlungsRhythmus(auszahlungen);
  const letzteMitGeld = auszahlungen
    .filter((a) => Math.abs(Number(a.betrag_cents) || 0) > 0)
    .sort((a, b) => (b.auszahlung_am ?? "").localeCompare(a.auszahlung_am ?? ""))[0] ?? null;

  const termine = terminMuster((basis.termin_gebuehren ?? []) as TerminZeile[]);
  const werbung = werbungsMuster((basis.werbung ?? []) as WerbungZeile[]);
  const reserve = reserveStand(
    (basis.reserve ?? []) as ReserveZeile[],
    letzteMitGeld ? Number(letzteMitGeld.betrag_cents) / 100 : null,
  );
  const gebunden = gebundenesGeld((basis.abrechnung_je_monat ?? []) as MonatZeile[]);

  // Vorsteuerabzug: die ausdrueckliche Angabe schlaegt die alte Vorgabe.
  const abzug = stamm.umsatzsteuerpflichtig === false
    ? false
    : (stamm.vorsteuerabzug ?? null);

  const vst = vorsteuer((basis.vorsteuer ?? []) as VorsteuerZeile[], {
    faktor,
    abzugsberechtigt: abzug,
    rhythmus: stamm.ust_voranmeldung ?? null,
    dauerfrist: stamm.ust_dauerfristverlaengerung ?? null,
  });

  const warnungen: string[] = [];
  if (rhythmus.belege < 3) {
    warnungen.push(
      `Der Auszahlungsrhythmus beruht auf nur ${rhythmus.belege} Abrechnung(en). `
      + "Für eine belastbare Aussage sind das zu wenige; die Termine unten sind "
      + "fortgeschrieben, nicht bestätigt.",
    );
  }
  if (gebunden.hinweis) warnungen.push(gebunden.hinweis);
  warnungen.push(...vst.hinweise);
  if (stamm.stammdaten_bestaetigt_am == null) {
    warnungen.push(
      "Die steuerlichen Stammdaten wurden noch nicht bestätigt. Was dort fehlt, "
      + "steht unten als „nicht angegeben“ und nicht als „nein“.",
    );
  }

  return {
    stand: basis.stand ?? null,
    fenster_tage: tage,

    auszahlung: {
      periode_tage: rhythmus.periode_tage,
      verzug_stunden: rhythmus.verzug_stunden,
      // Die Frage "wann ist der Schnitt" beantwortet der Bericht auf die
      // Sekunde — hier auf die Minute, in deutscher Zeit.
      schnitt_uhrzeit: rhythmus.schnitt_uhrzeit,
      belege: rhythmus.belege,
      letzte: letzteMitGeld
        ? { am: letzteMitGeld.auszahlung_am, betrag: r2(Number(letzteMitGeld.betrag_cents) / 100) }
        : null,
      naechste_termine: rhythmus.naechste,
    },

    einbehalt: reserve,
    gebundenes_geld: gebunden,
    termin_gebuehren: termine,
    werbung,
    vorsteuer: vst,

    stammdaten: {
      umsatzsteuerpflichtig: stamm.umsatzsteuerpflichtig ?? null,
      vorsteuerabzug: abzug,
      ust_voranmeldung: stamm.ust_voranmeldung ?? null,
      dauerfristverlaengerung: stamm.ust_dauerfristverlaengerung ?? null,
      ermaessigter_satz: stamm.ermaessigter_satz ?? null,
      oss: stamm.oss_teilnahme ?? null,
      pan_eu: stamm.pan_eu ?? null,
      lager_ausland: stamm.lager_ausland ?? null,
      lager_laender: stamm.lager_laender ?? null,
      bestaetigt_am: stamm.stammdaten_bestaetigt_am ?? null,
    },

    warnungen,
  };
}

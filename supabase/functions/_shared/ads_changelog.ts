// ads_changelog.ts — wann wurde welches Gebot geändert, und was kam danach.
//
// Die Frage dahinter ist immer dieselbe: lag der ACoS-Sprung an einer Änderung
// oder an Amazon? Pulse konnte sie bisher nicht beantworten. Es gab zwei Logs,
// aber die halten nur fest, was ÜBER PULSE geändert wurde — was jemand in der
// Amazon-Konsole tut, stand nirgends.
//
// Die Antwort steckte schon in den Tagesdaten: `ads_ziele_daily` speichert je
// Tag und Ziel Gebot und Status. Ein Unterschied zwischen zwei Tagen IST die
// Änderung, unabhängig davon, wer sie gemacht hat.
//
// Diese Datei rechnet daraus die Kennzahlen davor und danach — und hält drei
// Dinge auseinander, die man leicht verwechselt:
//
//  - GEMESSEN: Gebot vorher/nachher, Klicks, Kosten, Umsatz. Das steht fest.
//  - DATIERT: der Tag der Änderung. Oft nur auf ein Fenster genau, weil ein
//    Ziel nur an Tagen eine Zeile bekommt, an denen Amazon etwas meldet.
//  - BEHAUPTET: nichts. Der Vergleich davor/danach ist ein Nebeneinander.
//    In denselben sieben Tagen ändern sich Wettbewerb, Saison und Auktion mit.

import { marktplatzKopf } from "./ads_marktplatz.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Ab so vielen Klicks in BEIDEN Fenstern wird ein Vorher/Nachher gerechnet.
 *
 * Unter fünf Klicks ist der ACoS kein Messwert, sondern Zufall: ein einziger
 * Verkauf kippt ihn um den Faktor zehn. Bei Vaneja erfüllen 74 von 783
 * Änderungen diese Schwelle — die anderen bleiben im Protokoll, bekommen aber
 * keine Bewertung.
 */
export const KLICKS_FUER_VERGLEICH = 5;

export interface ChangelogZeile {
  am: string;
  luecke_tage: number;
  art: "gebot" | "status";
  ad_product: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_group_name: string | null;
  ziel_id: string | null;
  ziel_text: string | null;
  match_type: string | null;
  vorher: string | null;
  nachher: string | null;
  richtung: string | null;
  vorher_impressions: number; vorher_clicks: number; vorher_spend_cents: number;
  vorher_sales_cents: number; vorher_orders: number;
  nachher_impressions: number; nachher_clicks: number; nachher_spend_cents: number;
  nachher_sales_cents: number; nachher_orders: number;
  nachlauf_vollstaendig: boolean;
}

export interface Fenster {
  klicks: number;
  kosten: number;
  umsatz: number;
  bestellungen: number;
  /** Kosten / Umsatz. null = kein Umsatz, dann ist ACoS nicht definiert. */
  acos: number | null;
  /** Kosten je Klick. null = keine Klicks. */
  cpc: number | null;
}

export interface Aenderung {
  am: string;
  art: "gebot" | "status";
  /** 0 = der Tag steht fest. >0 = irgendwann in den N Tagen davor. */
  luecke_tage: number;
  datierung: string;
  kampagne: string | null;
  anzeigengruppe: string | null;
  ziel: string | null;
  match_type: string | null;
  ad_product: string | null;
  vorher: string | null;
  nachher: string | null;
  richtung: string | null;
  davor: Fenster;
  danach: Fenster;
  /** true = beide Fenster haben genug Klicks UND der Nachlauf ist vollständig. */
  vergleichbar: boolean;
  /** Warum nicht vergleichbar. null, wenn vergleichbar. */
  grund: string | null;
  /** Nur gesetzt, wenn vergleichbar: die Veränderung in Prozentpunkten bzw. Prozent. */
  acos_differenz: number | null;
  cpc_veraenderung_prozent: number | null;
  /** Nur gesetzt, wenn vergleichbar: Umsatz und ROAS danach gegen davor. */
  urteil: Urteil | null;
  /** Umsatz danach minus davor, in Euro. Nur gesetzt, wenn vergleichbar. */
  umsatz_differenz: number | null;
  /** Woraus sich die Umsatzdifferenz zusammensetzt. null, wenn nicht zerlegbar. */
  treiber: Treiber | null;
}

/**
 * Vier Felder statt einer Note. Bewusst beschreibend benannt: "beides besser"
 * sagt, was gemessen wurde — "sehr gut" würde behaupten, die Änderung sei der
 * Grund gewesen.
 */
export type Urteil =
  | "beides_besser"
  | "umsatz_besser_roas_schlechter"
  | "roas_besser_umsatz_schlechter"
  | "beides_schlechter"
  | "unveraendert";

export interface Treiber {
  /** Anteile der Umsatzdifferenz in Euro. Die vier Werte summieren sich zu ihr. */
  kosten: number;
  cpc: number;
  cvr: number;
  warenkorb: number;
  /** Der Faktor mit dem größten Betrag. */
  haupttreiber: "kosten" | "cpc" | "cvr" | "warenkorb";
}

/** Umsatz und ROAS danach gegen davor. null, wenn in einem Fenster keine Kosten liefen. */
export function urteilAus(davor: Fenster, danach: Fenster): Urteil | null {
  if (davor.kosten <= 0 || danach.kosten <= 0) return null;
  const u = Math.sign(danach.umsatz - davor.umsatz);
  const r = Math.sign(danach.umsatz / danach.kosten - davor.umsatz / davor.kosten);
  if (u === 0 && r === 0) return "unveraendert";
  if (u >= 0 && r >= 0) return "beides_besser";
  if (u <= 0 && r <= 0) return "beides_schlechter";
  return u > 0 ? "umsatz_besser_roas_schlechter" : "roas_besser_umsatz_schlechter";
}

/**
 * Zerlegt die Umsatzdifferenz in vier Faktoren.
 *
 *     Umsatz = Kosten x (1 / CPC) x CVR x Warenkorb
 *
 * Das ist eine Identität, keine Schätzung. Im Logarithmus wird aus dem Produkt
 * eine Summe, und jeder Faktor bekommt den Teil der Differenz, der seinem
 * Anteil an der Gesamtveränderung entspricht — die vier Teile ergeben zusammen
 * die Differenz. Ein gestiegener CPC zählt negativ: für dasselbe Geld gibt es
 * weniger Klicks.
 *
 * Geht nur, wenn beide Fenster Bestellungen haben; sonst sind CVR oder
 * Warenkorb null und der Logarithmus nicht definiert. Dann null statt einer
 * Näherung.
 */
export function treiberAus(davor: Fenster, danach: Fenster): Treiber | null {
  const ok = (f: Fenster) => f.klicks > 0 && f.kosten > 0 && f.umsatz > 0 && f.bestellungen > 0;
  if (!ok(davor) || !ok(danach)) return null;
  const diff = danach.umsatz - davor.umsatz;
  const gesamt = Math.log(danach.umsatz / davor.umsatz);
  if (gesamt === 0) return null;
  const cpc = (f: Fenster) => f.kosten / f.klicks;
  const cvr = (f: Fenster) => f.bestellungen / f.klicks;
  const korb = (f: Fenster) => f.umsatz / f.bestellungen;
  const teil = (l: number) => r2((l / gesamt) * diff);
  const t = {
    kosten: teil(Math.log(danach.kosten / davor.kosten)),
    cpc: teil(-Math.log(cpc(danach) / cpc(davor))),
    cvr: teil(Math.log(cvr(danach) / cvr(davor))),
    warenkorb: teil(Math.log(korb(danach) / korb(davor))),
  };
  const haupttreiber = (Object.keys(t) as Array<keyof typeof t>)
    .reduce((a, b) => (Math.abs(t[b]) > Math.abs(t[a]) ? b : a));
  return { ...t, haupttreiber };
}

export interface Bilanz {
  anzahl: number;
  urteile: Record<Urteil, number>;
  /** Summe der Umsatzdifferenzen aller Änderungen mit Zuwachs bzw. Rückgang, in Euro. */
  umsatz_zuwachs: number;
  umsatz_rueckgang: number;
}

/**
 * Bilanz der vergleichbaren Änderungen je Richtung (hoch / runter).
 *
 * Die Summen zählen dasselbe Ziel mehrfach, wenn es mehrfach geändert wurde,
 * und sie sind kein Gewinn und kein Verlust DURCH die Änderungen — nur das,
 * was in den sieben Tagen danach anders war.
 */
export function bilanzAus(aenderungen: Aenderung[]): Record<string, Bilanz> {
  const out: Record<string, Bilanz> = {};
  for (const a of aenderungen) {
    if (!a.vergleichbar || a.urteil === null || a.umsatz_differenz === null) continue;
    const b = out[a.richtung ?? "unbekannt"] ??= {
      anzahl: 0,
      urteile: {
        beides_besser: 0, umsatz_besser_roas_schlechter: 0,
        roas_besser_umsatz_schlechter: 0, beides_schlechter: 0, unveraendert: 0,
      },
      umsatz_zuwachs: 0, umsatz_rueckgang: 0,
    };
    b.anzahl++;
    b.urteile[a.urteil]++;
    if (a.umsatz_differenz > 0) b.umsatz_zuwachs = r2(b.umsatz_zuwachs + a.umsatz_differenz);
    else b.umsatz_rueckgang = r2(b.umsatz_rueckgang + a.umsatz_differenz);
  }
  return out;
}

export function fenster(klicks: number, kostenCents: number, umsatzCents: number, bestellungen: number): Fenster {
  const kosten = r2(kostenCents / 100);
  const umsatz = r2(umsatzCents / 100);
  return {
    klicks, kosten, umsatz, bestellungen,
    // Ohne Umsatz ist ACoS nicht "unendlich schlecht", sondern nicht definiert.
    // Eine Zahl dafür zu erfinden würde jede Rangliste verfälschen.
    acos: umsatz > 0 ? Math.round((kosten / umsatz) * 10000) / 10000 : null,
    cpc: klicks > 0 ? r2(kosten / klicks) : null,
  };
}

/** Aus einer RPC-Zeile wird ein Ereignis mit Bewertung — oder mit Begründung. */
export function baueAenderung(z: ChangelogZeile, minKlicks = KLICKS_FUER_VERGLEICH): Aenderung {
  const davor = fenster(
    Number(z.vorher_clicks) || 0, Number(z.vorher_spend_cents) || 0,
    Number(z.vorher_sales_cents) || 0, Number(z.vorher_orders) || 0,
  );
  const danach = fenster(
    Number(z.nachher_clicks) || 0, Number(z.nachher_spend_cents) || 0,
    Number(z.nachher_sales_cents) || 0, Number(z.nachher_orders) || 0,
  );

  const luecke = Number(z.luecke_tage) || 0;

  let grund: string | null = null;
  if (!z.nachlauf_vollstaendig) {
    grund = "Die sieben Tage nach der Änderung sind noch nicht vollständig — "
      + "der Nachher-Block ist angeschnitten.";
  } else if (davor.klicks < minKlicks || danach.klicks < minKlicks) {
    grund = `Zu wenig Traffic für einen Vergleich: ${davor.klicks} Klicks davor, `
      + `${danach.klicks} danach (nötig sind ${minKlicks} in beiden Fenstern). `
      + "Unter dieser Schwelle ist der ACoS Zufall, kein Messwert.";
  }

  const vergleichbar = grund === null;

  return {
    am: z.am,
    art: z.art,
    luecke_tage: luecke,
    // Der wichtigste Satz der Zeile: ein Ziel bekommt nur an Tagen eine Zeile,
    // an denen Amazon etwas meldet. Bei grossen Luecken ist der Tag geraten.
    datierung: luecke === 0
      ? "Tag steht fest"
      : `irgendwann in den ${luecke} Tagen davor — solange gab es keine Meldung zu diesem Ziel`,
    kampagne: z.campaign_name,
    anzeigengruppe: z.ad_group_name,
    ziel: z.ziel_text,
    match_type: z.match_type,
    ad_product: z.ad_product,
    vorher: z.vorher,
    nachher: z.nachher,
    richtung: z.richtung,
    davor,
    danach,
    vergleichbar,
    grund,
    acos_differenz: vergleichbar && davor.acos !== null && danach.acos !== null
      ? Math.round((danach.acos - davor.acos) * 10000) / 10000
      : null,
    cpc_veraenderung_prozent: vergleichbar && davor.cpc !== null && danach.cpc !== null && davor.cpc > 0
      ? Math.round(((danach.cpc - davor.cpc) / davor.cpc) * 1000) / 10
      : null,
    urteil: vergleichbar ? urteilAus(davor, danach) : null,
    umsatz_differenz: vergleichbar ? r2(danach.umsatz - davor.umsatz) : null,
    treiber: vergleichbar ? treiberAus(davor, danach) : null,
  };
}

export interface ChangelogArgs {
  von?: unknown; bis?: unknown; campaign_id?: unknown;
  limit?: unknown; nur_auswertbar?: unknown;
}

function alsDatum(v: unknown): string | null {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function adsChangelog(
  supabase: any, tenant_id: string, args: ChangelogArgs & { marktplatz?: unknown } = {},
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, args);

  const nurAuswertbar = args.nur_auswertbar === true || String(args.nur_auswertbar) === "true";
  const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000));

  const { data, error } = await supabase.rpc("ads_changelog", {
    p_tenant: tenant_id,
    p_von: alsDatum(args.von),
    p_bis: alsDatum(args.bis),
    p_campaign_id: args.campaign_id ? String(args.campaign_id) : null,
    p_limit: limit,
    p_min_klicks: nurAuswertbar ? KLICKS_FUER_VERGLEICH : 0,
    p_marktplatz: kopf.marktplatz,
  });
  if (error) throw new Error(`ads_changelog: ${error.message}`);

  const zeilen = ((data ?? []) as ChangelogZeile[]).map((z) => baueAenderung(z));
  const auswertbar = zeilen.filter((z) => z.vergleichbar);

  const hinweise: string[] = [
    "Diese Liste ist aus den TAGESSTÄNDEN abgeleitet, nicht aus einem Protokoll "
    + "von Amazon. Sie zeigt deshalb jede Änderung — auch die, die jemand direkt "
    + "in der Amazon-Konsole gemacht hat. Was sie NICHT sieht: eine Änderung, die "
    + "am selben Tag wieder zurückgenommen wurde.",
    "Die Kennzahlen davor und danach stehen nebeneinander, sie beweisen nichts. "
    + "In denselben sieben Tagen ändern sich Wettbewerb, Saison und Amazons "
    + "Auktion mit.",
  ];

  if (auswertbar.length > 0) {
    hinweise.push(
      "`urteil`, `treiber` und `bilanz` beschreiben, was nach der Änderung anders "
      + "war — nicht, was die Änderung bewirkt hat. Die Summen in `bilanz` zählen "
      + "ein Ziel mehrfach, wenn es mehrfach geändert wurde.",
    );
  }

  const ungenau = zeilen.filter((z) => z.luecke_tage > 0).length;
  if (ungenau > 0) {
    hinweise.push(
      `${ungenau} von ${zeilen.length} Änderungen lassen sich nicht auf den Tag `
      + "datieren: Ein Ziel bekommt nur an Tagen eine Zeile, an denen Amazon etwas "
      + "meldet. Bei diesen steht in `datierung`, wie breit das Fenster ist.",
    );
  }

  if (zeilen.length > 0 && auswertbar.length === 0) {
    hinweise.push(
      "Keine einzige Änderung hat genug Traffic für ein Vorher/Nachher. Das "
      + "heisst nicht, dass nichts passiert ist — nur, dass sich die Wirkung an "
      + "diesen Zielen nicht messen lässt.",
    );
  }

  return {
    ...kopf,
    zeitraum: {
      von: alsDatum(args.von), bis: alsDatum(args.bis),
      hinweis: alsDatum(args.von) ? null : "Ohne Angabe die letzten 90 Tage.",
    },
    anzahl: zeilen.length,
    davon_auswertbar: auswertbar.length,
    klick_schwelle: KLICKS_FUER_VERGLEICH,
    // Je Richtung (hoch / runter): wie oft welches Urteil, und die Summen.
    bilanz: bilanzAus(zeilen),
    aenderungen: zeilen,
    hinweise,
  };
}

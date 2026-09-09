// produkte.ts — Per-Produkt-Übersicht je ASIN.
//
// Die Rechnung:
//   Nettoumsatz  = Umsatz − Umsatzsteuer
//   Rohertrag    = Nettoumsatz − Einkaufspreis
//   Nettogewinn  = Rohertrag − Amazon-Gebühren (netto) − Werbekosten
//
// Zwei Steuerbeträge, die nichts miteinander zu tun haben und beide raus müssen:
//
//   1. Umsatzsteuer auf den UMSATZ. Der Verkäufer vereinnahmt sie und führt sie
//      ab — sie war nie sein Geld. 9.356 € brutto sind bei 19 % nur 7.862 €.
//   2. Vorsteuer in den GEBÜHREN. Amazon bucht sie ohne Ausweis mit; bei
//      Vorsteuerabzug kommt sie zurück und ist kein Kosten.
//
// Beides folgt aus dem Steuerprofil der Firma. Die Marge auf den Bruttoumsatz zu
// rechnen, während die Gebühren netto stehen, macht jede Zahl systematisch zu
// schön — genau in der Größenordnung des Steuersatzes.
//
// Werbekosten kommen je ASIN aus ads_daily (seit 2026-08-17 angebunden). Ohne
// Ads-Verbindung bleiben sie UNBEKANNT, nicht 0 — sonst stünde da ein Gewinn,
// den es so nicht gibt.
//
// Zusätzlich die Kette JE EINHEIT, die den Break-even ACOS herleitet:
//   VK brutto − USt = VK netto − Gebühren − EK = DB vor Werbung
//   Break-even ACOS = DB vor Werbung / VK netto
//   − Werbung = DB nach Werbung;  TACOS = Werbung / Nettoumsatz gesamt
// Ohne diese Herleitung ist der Break-even eine Zahl, die man glauben muss.
//
// Ziel-ACOS und Umsatzsteuersatz kommen je Produkt aus asin_einstellungen;
// fehlt der Steuersatz dort, gilt der Mandanten-Wert.

import { nettoGebuehr } from "./ust_faktor.ts";
import { pruefeGebuehren } from "./gebuehren_pruefung.ts";
import { ladeUstFaktor } from "./ust_lauf.ts";

function runde(n: number, stellen = 2): number {
  const f = 10 ** stellen;
  return Math.round(n * f) / f;
}

interface Row {
  asin: string; produktname: string; umsatz_cents: number; einheiten: number;
  wareneinsatz_cents: number; einheiten_mit_ek: number; retouren: number;
  gebuehren_cents: number; gebuehren_bekannt: boolean; gebuehren_anteilig: boolean;
  fba_cents: number; verkaufsgebuehr_cents: number; sonstige_gebuehren_cents: number;
  lager_cents?: number; gutschriften_cents?: number;
  gebuehren_direkt_cents?: number; gebuehren_umgelegt_cents?: number;
  gebuehren_abdeckung?: number | null; gebuehren_vollstaendig?: boolean;
}

function istDatum(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function produktUebersicht(
  supabase: any, tenant_id: string, opts?: { tage?: unknown; von?: unknown; bis?: unknown },
): Promise<unknown> {
  let von: string, bis: string;
  if (istDatum(opts?.von) && istDatum(opts?.bis)) {
    // Frei gewählter Zeitraum (Kalender).
    von = opts!.von as string;
    bis = opts!.bis as string;
    if (von > bis) [von, bis] = [bis, von];
  } else {
    // Preset: letzte N Tage.
    const fenster = Number(opts?.tage) > 0 ? Number(opts?.tage) : 90;
    von = new Date(Date.now() - fenster * 86400000).toISOString().slice(0, 10);
    bis = new Date().toISOString().slice(0, 10);
  }
  const [{ data, error }, ustFaktor, einstellung, jeAsin, adsRes, lagerRes] = await Promise.all([
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    ladeUstFaktor(supabase, tenant_id),
    supabase.from("tenant_einstellungen").select("umsatzsteuer_prozent")
      .eq("tenant_id", tenant_id).maybeSingle(),
    supabase.from("asin_einstellungen").select("asin, ziel_acos_prozent, ust_prozent")
      .eq("tenant_id", tenant_id),
    // Werbekosten je ASIN aus der Tagesreihe — derselbe Zeitraum, damit die
    // Kette in einer Zeile aufgeht.
    supabase.rpc("ads_summen", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
    // Welche Monate des Fensters haben ueberhaupt Lagergebuehren-Daten?
    supabase.rpc("lager_abdeckung", { p_tenant: tenant_id, p_von: von, p_bis: bis }),
  ]);
  if (error) throw new Error(`produkt_uebersicht: ${error.message}`);

  const proAsin = new Map<string, { ziel_acos_prozent: number | null; ust_prozent: number | null }>();
  for (const e of (jeAsin?.data ?? []) as any[]) {
    proAsin.set(String(e.asin), {
      ziel_acos_prozent: e.ziel_acos_prozent == null ? null : Number(e.ziel_acos_prozent),
      ust_prozent: e.ust_prozent == null ? null : Number(e.ust_prozent),
    });
  }

  // Werbung je ASIN in Euro. Fehlt die Ads-Verbindung, bleibt die Karte leer —
  // dann ist Werbung UNBEKANNT, nicht 0.
  const werbungJeAsin = new Map<string, number>();
  for (const r of (adsRes?.data ?? []) as any[]) {
    if (r.ebene === "asin" && r.schluessel) {
      werbungJeAsin.set(String(r.schluessel), Number(r.spend_cents) / 100);
    }
  }
  const hatWerbung = werbungJeAsin.size > 0;

  // Umsatzsteuersatz auf den eigenen Umsatz. 19 % ist der Regelfall in
  // Deutschland; 0 bei Kleinunternehmern, deren Umsatz bereits netto ist.
  const ustSatz = Number(einstellung?.data?.umsatzsteuer_prozent ?? 19);
  const umsatzTeiler = Number.isFinite(ustSatz) && ustSatz >= 0 && ustSatz < 100
    ? 1 + ustSatz / 100
    : 1;

  const produkte = ((data ?? []) as Row[]).map((r) => {
    const eig = proAsin.get(r.asin);
    // Steuersatz je Produkt, sonst der Mandanten-Wert. 7 % gilt z. B. für
    // Lebensmittel — mandantenweit wäre das für gemischte Sortimente falsch.
    const satzProdukt = eig?.ust_prozent ?? null;
    const teiler = satzProdukt !== null && satzProdukt >= 0 && satzProdukt < 100
      ? 1 + satzProdukt / 100
      : umsatzTeiler;

    const umsatzBrutto = (Number(r.umsatz_cents) || 0) / 100;
    // Alles Weitere rechnet auf dem NETTOUMSATZ. Die vereinnahmte Umsatzsteuer
    // gehört dem Finanzamt; sie in Marge oder Gewinn zu führen wäre erfunden.
    const umsatz = runde(umsatzBrutto / teiler);
    const umsatzsteuer = runde(umsatzBrutto - umsatz);
    const wareneinsatz = (Number(r.wareneinsatz_cents) || 0) / 100;
    const einheiten = Number(r.einheiten) || 0;
    const hatEk = (Number(r.einheiten_mit_ek) || 0) > 0;
    const rohertrag = hatEk ? runde(umsatz - wareneinsatz) : null;
    const retouren = Number(r.retouren) || 0;

    // Amazon-Gebühren je Produkt (signiert, negativ = Kosten).
    // Ohne bestätigten Faktor lässt nettoGebuehr den Betrag unverändert.
    const hatGeb = Boolean(r.gebuehren_bekannt);
    // Die zwei grossen Bloecke einzeln — sie haben verschiedene Hebel: die
    // Verkaufsgebuehr haengt am Preis, die FBA-Gebuehr an Groesse und Gewicht.
    const je = (cents: unknown) => hatGeb ? nettoGebuehr(Number(cents) || 0, ustFaktor) / 100 : null;
    const fba = je(r.fba_cents);
    const verkaufsgebuehr = je(r.verkaufsgebuehr_cents);
    const sonstige = je(r.sonstige_gebuehren_cents);
    const lager = je(r.lager_cents ?? 0);
    // Gutschriften NICHT durch den USt.-Faktor teilen.
    //
    // Erstattungen (fehlende Ware beim Wareneingang, Neubewertung) sind keine
    // Gebuehr mit Vorsteuer darauf, sondern ein Ersatz fuer den Warenwert. Wer
    // sie mitteilt, kuerzt eine Gutschrift um eine Steuer, die nie darauf lag —
    // und der Fehler faellt nicht auf, weil das Ergebnis plausibel aussieht.
    const gutschriften = hatGeb ? (Number(r.gutschriften_cents) || 0) / 100 : null;
    // Gesamt: USt.-behaftete Gebuehren netto PLUS Gutschriften zum Nennwert.
    const gebuehren = hatGeb
      ? runde(nettoGebuehr(Number(r.gebuehren_cents) || 0, ustFaktor) / 100 + (gutschriften ?? 0))
      : null;

    // Deckungsbeitrag VOR Werbung. Der Name sagt ausdrücklich „vor", damit
    // niemand ihn für das Endergebnis hält.
    const vorWerbung = hatEk && hatGeb && rohertrag != null ? runde(rohertrag + gebuehren!) : null;
    // Zwischenstufe ohne EK: was nach Amazon übrig bleibt.
    const umsatzNachGebuehren = hatGeb ? runde(umsatz + gebuehren!) : null;

    // --- Die Kette je Einheit ---
    //
    // Break-even ACOS ist keine eigenständige Größe, sondern der Deckungsbeitrag
    // vor Werbung in Prozent vom Nettoumsatz: so viel Werbung verträgt das
    // Produkt, bevor es sich nicht mehr trägt. Als nackte Prozentzahl ist das
    // nicht nachvollziehbar — deshalb hier jede Stufe einzeln, in Euro.
    //
    // Je Einheit statt je Zeitraum, weil sich so über Produkte vergleichen
    // lässt: „ich verkaufe für X, davon bleibt Y".
    const jeStueck = (wert: number | null) =>
      wert == null || einheiten <= 0 ? null : runde(wert / einheiten);

    const werbung = werbungJeAsin.get(r.asin) ?? (hatWerbung ? 0 : null);
    const nachWerbung = vorWerbung != null && werbung != null ? runde(vorWerbung - werbung) : null;

    return {
      asin: r.asin,
      produktname: r.produktname,
      umsatz,                 // netto — die Basis aller Quoten
      umsatz_brutto: runde(umsatzBrutto),
      umsatzsteuer,
      // Wareneinsatz sichtbar machen: ohne ihn ist der Rohertrag eine Behauptung.
      // null statt 0, solange kein EK hinterlegt ist — 0 hiesse "kostenlos".
      wareneinsatz: hatEk ? runde(wareneinsatz) : null,
      einheiten,
      retouren,
      rohertrag,
      rohmarge: hatEk && umsatz > 0 && rohertrag != null ? runde((rohertrag / umsatz) * 100, 1) : null,
      retourenquote: einheiten > 0 ? runde((retouren / einheiten) * 100, 1) : null,
      gebuehren: gebuehren == null ? null : runde(gebuehren),
      fba_gebuehr: fba == null ? null : runde(fba),
      verkaufsgebuehr: verkaufsgebuehr == null ? null : runde(verkaufsgebuehr),
      sonstige_gebuehren: sonstige == null ? null : runde(sonstige),
      lagergebuehr: lager == null ? null : runde(lager),
      gutschriften: gutschriften == null ? null : runde(gutschriften),
      gebuehren_direkt: hatGeb ? runde(nettoGebuehr(Number(r.gebuehren_direkt_cents) || 0, ustFaktor) / 100) : null,
      gebuehren_umgelegt_betrag: hatGeb ? runde((Number(r.gebuehren_umgelegt_cents) || 0) / 100) : null,
      // Wie viele Bestellzeilen des Zeitraums schon abgerechnet sind. Amazon
      // rechnet mit Verzug ab; im laufenden Monat ist die Quote klein, und dann
      // sind niedrige Gebuehren je Stueck kein guter Wert, sondern ein halber.
      gebuehren_abdeckung: r.gebuehren_abdeckung == null ? null : Number(r.gebuehren_abdeckung),
      gebuehren_vollstaendig: r.gebuehren_vollstaendig ?? null,
      gebuehrenquote: hatGeb && umsatz > 0 ? runde((-gebuehren! / umsatz) * 100, 1) : null,
      gebuehren_anteilig: Boolean(r.gebuehren_anteilig),
      umsatz_nach_gebuehren: umsatzNachGebuehren,
      werbekosten: werbung == null ? null : runde(werbung),
      nettogewinn_vor_werbung: vorWerbung,
      marge_vor_werbung: vorWerbung != null && umsatz > 0 ? runde((vorWerbung / umsatz) * 100, 1) : null,
      nettogewinn: nachWerbung,
      nettomarge: nachWerbung != null && umsatz > 0 ? runde((nachWerbung / umsatz) * 100, 1) : null,

      // --- Kette je Einheit (die Herleitung des Break-even) ---
      einheiten_basis: einheiten,
      vk_brutto: jeStueck(umsatzBrutto),
      ust_prozent: satzProdukt ?? ustSatz,
      ust_je_stueck: jeStueck(umsatzsteuer),
      vk_netto: jeStueck(umsatz),
      // Gebühren kommen signiert (negativ) — hier als positiver Abzug zeigen.
      gebuehren_je_stueck: gebuehren == null ? null : jeStueck(-gebuehren),
      // Aufschluesselung der Gebuehren, damit die Summe nachpruefbar ist:
      // Verkaufsprovision haengt am Preis, die FBA-Gebuehr an Groesse und
      // Gewicht — verschiedene Hebel, deshalb einzeln.
      fba_je_stueck: fba == null ? null : jeStueck(-fba),
      verkaufsgebuehr_je_stueck: verkaufsgebuehr == null ? null : jeStueck(-verkaufsgebuehr),
      sonstige_je_stueck: sonstige == null ? null : jeStueck(-sonstige),
      ek_je_stueck: hatEk ? jeStueck(wareneinsatz) : null,
      db_vor_werbung_je_stueck: jeStueck(vorWerbung),
      // Das ist die Zahl, die vorher unerklärt in der Spalte stand.
      break_even_acos: vorWerbung != null && umsatz > 0 ? runde((vorWerbung / umsatz) * 100, 1) : null,
      werbung_je_stueck: jeStueck(werbung),
      db_nach_werbung_je_stueck: jeStueck(nachWerbung),
      // Tatsächlicher ACOS: Werbung gemessen am beworbenen Umsatz kennt nur die
      // Ads-Seite. TACOS misst sie am GESAMTumsatz des Produkts — die ehrlichere
      // Grösse, weil organische Verkäufe die Werbung mittragen.
      tacos: werbung != null && umsatz > 0 ? runde((werbung / umsatz) * 100, 1) : null,
      ziel_acos_prozent: eig?.ziel_acos_prozent ?? null,
    };
  });

  // Lagergebuehren: Amazon gibt den Bericht mit Verzug heraus. Fehlt ein Monat,
  // ist die Lagergebuehr fuer ihn UNBEKANNT, nicht null. Das gehoert in die
  // Ausgabe, sonst rechnet der Leser mit einer Null weiter, die es nicht gibt.
  const lagerFehlend: string[] = ((lagerRes?.data ?? []) as any[])
    .filter((z) => !z.hat_daten).map((z) => String(z.monat));

  // Der laufende Monat KANN noch keine Lagergebuehr haben — Amazon rechnet sie
  // erst nach Monatsende ab. Das ist etwas anderes als ein abgeschlossener
  // Monat, der fehlt. Beides verfaelscht die Marge, aber nur das zweite ist ein
  // Datenproblem, und wer beides gleich benennt, wird nach dem dritten Mal
  // keine Warnung mehr lesen.
  const laufend = new Date().toISOString().slice(0, 7);
  const fehlendAbgeschlossen = lagerFehlend.filter((m) => m < laufend);
  const laufendFehlt = lagerFehlend.includes(laufend);

  const warnungen: string[] = [];
  if (fehlendAbgeschlossen.length > 0) {
    warnungen.push(
      `Für ${fehlendAbgeschlossen.length === 1 ? "den Monat" : "die Monate"} `
      + `${fehlendAbgeschlossen.join(", ")} liegen noch keine Lagergebühren vor — `
      + "Amazon gibt den Lagergebührenbericht erst mit einigen Wochen Verzug "
      + "heraus. Die ausgewiesene Lagergebühr ist für diese Monate NICHT null, "
      + "sondern unbekannt; Marge und Gewinn fallen dadurch zu günstig aus.",
    );
  }
  if (laufendFehlt) {
    warnungen.push(
      `Der laufende Monat (${laufend}) enthält noch keine Lagergebühr — Amazon `
      + "rechnet sie erst nach Monatsende ab. Auch hier steht 0,00 € für "
      + "unbekannt, nicht für null.",
    );
  }
  const unvollstaendig = produkte.filter((p: any) =>
    p.gebuehren_abdeckung != null && p.gebuehren_abdeckung < 0.95);
  if (unvollstaendig.length > 0) {
    warnungen.push(
      `${unvollstaendig.length} Produkt(e) haben noch nicht abgerechnete `
      + "Bestellungen im Zeitraum. Amazon rechnet mit Verzug ab; die Gebühren "
      + "sind dort unvollständig, nicht niedrig. Siehe `gebuehren_abdeckung` "
      + "je Produkt.",
    );
  }

  const mitGebuehren = produkte.filter((p) => p.gebuehren != null);
  return {
    von, bis,
    waehrung: "EUR",
    produkte,
    summe_retouren: produkte.reduce((s, p) => s + p.retouren, 0),
    // Gebühren-Überblick: was ist bekannt, wie verlässlich ist die Zuordnung?
    // Auffaellige Gebuehren. Sie aendern nichts an den Zahlen, sie sagen nur, wo
    // eine nicht zu ihrer Umgebung passt — genau das hat beim Fall vom 09.09.
    // gefehlt: 25,6 % Verkaufsgebuehr sahen fuer sich genommen unauffaellig aus.
    gebuehren_befunde: pruefeGebuehren(produkte.map((p: any) => ({
      asin: p.asin, produktname: p.produktname, einheiten: p.einheiten,
      umsatz_brutto: p.umsatz_brutto ?? p.umsatz, umsatz: p.umsatz,
      verkaufsgebuehr: p.verkaufsgebuehr, fba_gebuehr: p.fba_gebuehr,
      gebuehren: p.gebuehren, gebuehren_abdeckung: p.gebuehren_abdeckung,
    }))),
    lagergebuehr_monate_fehlend: lagerFehlend,
    lagergebuehr_vollstaendig: lagerFehlend.length === 0,
    // Warnungen fuer den LESER — Mensch wie KI. Ueber MCP oder ChatGPT sieht
    // niemand die Datenlage, nur die Zahl. Eine fehlende Lagergebuehr steht dort
    // sonst als 0,00 EUR und liest sich wie "keine Lagerkosten".
    warnungen,
    hat_gebuehren: mitGebuehren.length > 0,
    summe_gebuehren: mitGebuehren.length ? runde(mitGebuehren.reduce((s, p) => s + (p.gebuehren ?? 0), 0)) : null,
    gebuehren_anteilig: produkte.some((p) => p.gebuehren_anteilig),
    produkte_ohne_gebuehren: produkte.filter((p) => p.umsatz > 0 && p.gebuehren == null).length,
    // Damit die Anzeige sagen kann, WORAUF die Marge steht.
    gebuehren_ust_faktor: ustFaktor,
    gebuehren_basis: ustFaktor === null ? "wie_gebucht" : (ustFaktor <= 1.005 ? "netto_ohne_ust" : "netto"),
    umsatzsteuer_prozent: ustSatz,
    summe_umsatz_netto: runde(produkte.reduce((s, p) => s + p.umsatz, 0)),
    summe_umsatzsteuer: runde(produkte.reduce((s, p) => s + p.umsatzsteuer, 0)),
    hat_werbekosten: hatWerbung,
    rechenweg: "Je Einheit: VK brutto − Umsatzsteuer = VK netto. Davon Amazon-Gebühren (netto) " +
      "und Einkaufspreis ab = Deckungsbeitrag vor Werbung. Dessen Anteil am VK netto IST der " +
      "Break-even ACOS. Davon die tatsächliche Werbung ab = Deckungsbeitrag nach Werbung. " +
      "TACOS = Werbung / Nettoumsatz gesamt (nicht nur beworbener Umsatz).",
    fehlt: hatWerbung
      ? []
      : ["Werbekosten (PPC) — keine Ads-Verbindung für diesen Mandanten, Werbung ist unbekannt (nicht 0)"],
  };
}

// gebuehrenaenderung_lauf.ts — DB-Schicht für die Gebühren-Vorschau.
// Die Rechenregeln liegen rein und getestet in gebuehrenaenderung.ts.
//
// Was hier zusammenkommt:
//   * fee_schedule — dieselbe Tabelle wie im laufenden Betrieb, nur zwei
//     Gültigkeitsstände statt einem. Eine angekündigte Änderung ist ein Import
//     mit einem Datum in der Zukunft; es gibt keinen zweiten Speicherort.
//   * korridor_produkte — Amazons gemessene Maße, Klasse, Preis und der Absatz
//     je SKU.
//   * produkt_uebersicht — die gemessene Stückrechnung je ASIN (Nettoumsatz,
//     Einkauf, gebuchte Gebühren), damit die Marge nicht geschätzt werden muss.
//   * Zielmarge — Korridor der ASIN, sonst der Rolle, sonst Firmenvorgabe.
//
// Ohne künftige Rate Card gibt es keine Vorschau. Dann sagt das Modul genau das
// und nennt den Weg dorthin, statt eine leere Tabelle zu zeigen.

import { baueKlassen, marktplatzFuer } from "./korridor_lauf.ts";
import { niedrigpreisGrenze } from "./groessenklassen.ts";
import { produktUebersicht } from "./produkte.ts";
import {
  simuliere, zielmargeAus,
  type AsinErtrag, type Zielmarge,
} from "./gebuehrenaenderung.ts";
import type { Klasse, Produkt } from "./groessenklassen.ts";

/** Die Kennzahl, an der die Zielmarge hängt. Dieselbe wie im Strategie-Pfad. */
export const ZIEL_KENNZAHL = "deckungsbeitrag_nach_werbung";

function heute(): string {
  return new Date().toISOString().slice(0, 10);
}

function nz(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

interface Version {
  gueltig_ab: string;
  zeilen: number;
  tarife: string[];
  kuenftig: boolean;
}

/** Die Gültigkeitsstände einer Gebührentabelle, neuester zuerst. Rein. */
export function baueVersionen(zeilen: any[], stichtag: string): Version[] {
  const proAb = new Map<string, { zeilen: number; tarife: Set<string> }>();
  for (const z of zeilen) {
    const ab = String(z.gueltig_ab);
    const e = proAb.get(ab) ?? { zeilen: 0, tarife: new Set<string>() };
    e.zeilen++;
    e.tarife.add(z.tarif === "niedrigpreis" ? "niedrigpreis" : "standard");
    proAb.set(ab, e);
  }
  return [...proAb.entries()]
    .map(([gueltig_ab, e]) => ({
      gueltig_ab, zeilen: e.zeilen, tarife: [...e.tarife].sort(),
      kuenftig: gueltig_ab > stichtag,
    }))
    .sort((a, b) => (a.gueltig_ab < b.gueltig_ab ? 1 : -1));
}

/**
 * Welche zwei Stände werden verglichen?
 *   * „alt" = der Stand, nach dem HEUTE abgerechnet wird.
 *   * „neu" = der gewünschte, sonst der nächste angekündigte.
 * Rein, damit die Auswahlregel prüfbar ist.
 */
export function waehleVersionen(
  versionen: Version[], stichtag: string, gewuenscht?: string | null,
): { alt: string | null; neu: string | null } {
  const alt = versionen.filter((v) => v.gueltig_ab <= stichtag)
    .map((v) => v.gueltig_ab).sort().pop() ?? null;
  const kuenftig = versionen.filter((v) => v.kuenftig).map((v) => v.gueltig_ab).sort();
  const neu = gewuenscht && versionen.some((v) => v.gueltig_ab === gewuenscht)
    ? gewuenscht
    : (kuenftig[0] ?? null);
  return { alt, neu };
}

/** Zielmarge je ASIN aus Korridor-Override, Rollen-Korridor und Firmenvorgabe. */
async function ladeZiele(
  supabase: any, tenant_id: string, firmaProzent: number | null,
): Promise<Map<string, Zielmarge>> {
  const [rollenRes, defsRes, ovRes] = await Promise.all([
    supabase.from("asin_strategien").select("asin, rolle")
      .eq("tenant_id", tenant_id).is("gueltig_bis", null),
    supabase.from("strategie_definitionen").select("rolle, korridore"),
    supabase.from("strategie_korridor").select("asin, min, max")
      .eq("tenant_id", tenant_id).eq("kennzahl", ZIEL_KENNZAHL),
  ]);
  const rolleVon = new Map<string, string>(
    (rollenRes.data ?? []).map((r: any) => [String(r.asin), String(r.rolle)]),
  );
  const rollenKorridor = new Map<string, { min: number | null; max: number | null }>();
  for (const d of defsRes.data ?? []) {
    const k = (d.korridore ?? {})[ZIEL_KENNZAHL];
    if (k) rollenKorridor.set(String(d.rolle), { min: nz(k.min), max: nz(k.max) });
  }
  const override = new Map<string, { min: number | null; max: number | null }>(
    (ovRes.data ?? []).map((r: any) => [String(r.asin), { min: nz(r.min), max: nz(r.max) }]),
  );

  const ziele = new Map<string, Zielmarge>();
  for (const asin of new Set([...rolleVon.keys(), ...override.keys()])) {
    const rolle = rolleVon.get(asin) ?? null;
    ziele.set(asin, zielmargeAus(
      override.get(asin) ?? null,
      rolle ? (rollenKorridor.get(rolle) ?? null) : null,
      firmaProzent, rolle,
    ));
  }
  // ASINs ohne Rolle und ohne Override bekommen die Firmenvorgabe — oder nichts.
  // Der Aufrufer liest fehlende Einträge als „leer"; damit die Quelle trotzdem
  // stimmt, wird die Firmenvorgabe hier als Standard mitgegeben.
  return ziele;
}

export async function gebuehrenVorschau(
  supabase: any, tenant_id: string, opts?: { tage?: unknown; gueltig_ab?: unknown },
): Promise<unknown> {
  const tage = Number(opts?.tage) > 0 ? Math.min(Number(opts?.tage), 730) : 365;
  const gewuenscht = typeof opts?.gueltig_ab === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.gueltig_ab)
    ? opts.gueltig_ab
    : null;
  const stichtag = heute();

  const markt = await marktplatzFuer(supabase, tenant_id);
  if (!markt) {
    return leer(null, [], "Der Marktplatz dieser Firma ist nicht bekannt — ohne ihn lässt sich keine Gebührentabelle zuordnen.");
  }

  const { data: schedule, error: sErr } = await supabase.from("fee_schedule")
    .select("*").eq("marketplace", markt);
  if (sErr) throw new Error(`fee_schedule: ${sErr.message}`);
  const zeilen = (schedule ?? []) as any[];
  const versionen = baueVersionen(zeilen, stichtag);
  const { alt, neu } = waehleVersionen(versionen, stichtag, gewuenscht);

  if (!alt) {
    return leer(markt, versionen, `Für ${markt} ist keine gültige Gebührentabelle hinterlegt. Ohne den heutigen Stand gibt es nichts zu vergleichen.`);
  }
  if (!neu) {
    return leer(markt, versionen,
      "Es ist keine künftige Gebührentabelle hinterlegt. Sobald Amazon eine Änderung ankündigt, " +
      "wird sie unter Gebührentabelle mit ihrem Startdatum importiert — diese Vorschau rechnet sie dann durch.");
  }
  if (alt === neu) {
    return leer(markt, versionen, "Der gewählte Stand ist der heute gültige — es gibt keinen Unterschied zu rechnen.");
  }

  const klassenAlt: Klasse[] = baueKlassen(zeilen.filter((z) => z.gueltig_ab === alt));
  const klassenNeu: Klasse[] = baueKlassen(zeilen.filter((z) => z.gueltig_ab === neu));

  const [produkteRes, uebersicht, einstellung] = await Promise.all([
    supabase.rpc("korridor_produkte", { p_tenant: tenant_id, p_markt: markt, p_tage: tage }),
    produktUebersicht(supabase, tenant_id, { tage }),
    supabase.from("tenant_einstellungen").select("ziel_marge_prozent")
      .eq("tenant_id", tenant_id).maybeSingle(),
  ]);
  if (produkteRes.error) throw new Error(`korridor_produkte: ${produkteRes.error.message}`);

  const produkte: Produkt[] = ((produkteRes.data ?? []) as any[]).map((r) => ({
    sku: String(r.sku),
    asin: r.asin ?? null,
    produktname: r.produktname ?? null,
    laengste_seite_cm: nz(r.laengste_seite_cm),
    mittlere_seite_cm: nz(r.mittlere_seite_cm),
    kuerzeste_seite_cm: nz(r.kuerzeste_seite_cm),
    gewicht_g: nz(r.gewicht_g),
    groessenklasse: r.groessenklasse ?? null,
    preis_cents: nz(r.preis_cents),
    fulfilment_cents: nz(r.fulfilment_cents),
    einheiten: Number(r.einheiten) || 0,
    fenster_tage: Number(r.fenster_tage) || tage,
  }));
  if (produkte.length === 0) {
    return leer(markt, versionen, "Der Gebührenvorschau-Report liegt noch nicht vor. Ohne ihn kennt Pulse weder Maße noch Größenklasse.");
  }

  const u = uebersicht as any;
  const ertraege: AsinErtrag[] = (u.produkte ?? []).map((p: any) => ({
    asin: String(p.asin),
    produktname: p.produktname ?? null,
    einheiten: Number(p.einheiten) || 0,
    umsatz_netto: Number(p.umsatz) || 0,
    wareneinsatz: nz(p.wareneinsatz),
    fba_gebuehr: nz(p.fba_gebuehr),
    verkaufsgebuehr: nz(p.verkaufsgebuehr),
    sonstige_gebuehren: nz(p.sonstige_gebuehren),
  }));

  const firmaZiel = nz(einstellung?.data?.ziel_marge_prozent);
  const ziele = await ladeZiele(supabase, tenant_id, firmaZiel);
  // ASINs ohne eigenen Eintrag erben die Firmenvorgabe — mit ihrer Quelle.
  for (const e of ertraege) {
    if (!ziele.has(e.asin)) ziele.set(e.asin, zielmargeAus(null, null, firmaZiel, null));
  }

  const r = simuliere({
    produkte, klassenAlt, klassenNeu, ertraege, ziele,
    umsatzsteuerProzent: Number(u.umsatzsteuer_prozent ?? 19),
  });

  // Fehlt die Niedrigpreistabelle, fallen genau die günstigen Artikel heraus —
  // bei manchen Konten die absatzstärksten. Das wird beziffert, statt es dem
  // Leser als „nicht bewertbar" ohne Zusammenhang hinzustellen.
  const grenze = niedrigpreisGrenze([...klassenAlt, ...klassenNeu]);
  const niedrigpreisGepflegt = klassenAlt.some((k) => k.tarif === "niedrigpreis") &&
    klassenNeu.some((k) => k.tarif === "niedrigpreis");
  const betroffen = produkte.filter((p) => p.preis_cents !== null && p.preis_cents < grenze);
  const betroffenEinheiten = betroffen.reduce((s, p) => s + p.einheiten, 0);

  return {
    marktplatz: markt,
    versionen,
    version_alt: alt,
    version_neu: neu,
    tage_bis_wirksam: tageZwischen(stichtag, neu),
    fenster_tage: produkte[0].fenster_tage,
    zielmarge_kennzahl: ZIEL_KENNZAHL,
    zielmarge_firma: firmaZiel,
    hat_werbekosten: Boolean(u.hat_werbekosten),
    niedrigpreis_grenze_eur: grenze / 100,
    niedrigpreis_tabelle_hinterlegt: niedrigpreisGepflegt,
    niedrigpreis_produkte: betroffen.length,
    ...r,
    rechenweg:
      "Versandgebühr je Stück laut Rate Card (inkl. 1,5 % Treibstoffaufschlag), einmal " +
      "nach dem heute gültigen und einmal nach dem künftigen Stand. Marge = Nettoumsatz " +
      "− Einkauf − Amazon-Gebühren, je Stück. Der nötige Preis rechnet die mitsteigende " +
      "Verkaufsgebühr ein.",
    hinweis_werbung:
      "Werbekosten sind nicht enthalten (Ads-API nicht verbunden). Beweisbar ist deshalb " +
      "nur eine Richtung: Wer schon vor Werbung unter der Zielmarge liegt, liegt auch " +
      "danach darunter. „Hält die Marge\" ist unbestätigt — der ausgewiesene Puffer ist " +
      "genau der Werbeanteil, den das Produkt noch verträgt.",
    hinweis_niedrigpreis: !niedrigpreisGepflegt && betroffen.length > 0
      ? `${betroffen.length} Produkt(e) mit zusammen ${betroffenEinheiten} verkauften Einheiten kosten ` +
        `unter ${(grenze / 100).toFixed(2)} € und werden nach dem Niedrigpreisversand abgerechnet ` +
        "(Rate Card S. 5). Diese Tabelle ist für mindestens einen der beiden Stände nicht hinterlegt — " +
        "sie bleiben deshalb außen vor. Auf der Standardtabelle gerechnet wäre ihr Mehrbetrag erfunden."
      : null,
  };
}

/** Ganze Tage zwischen zwei ISO-Daten. Nie negativ. */
export function tageZwischen(von: string, bis: string): number {
  const a = Date.parse(`${von}T00:00:00Z`);
  const b = Date.parse(`${bis}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

function leer(markt: string | null, versionen: Version[], grund: string) {
  return {
    marktplatz: markt, versionen,
    version_alt: null, version_neu: null, tage_bis_wirksam: null,
    fenster_tage: null, zielmarge_kennzahl: ZIEL_KENNZAHL, zielmarge_firma: null,
    hat_werbekosten: false,
    niedrigpreis_grenze_eur: null, niedrigpreis_tabelle_hinterlegt: false,
    niedrigpreis_produkte: 0, hinweis_niedrigpreis: null,
    deltas: [], befunde: [], unter_ziel: [],
    anzahl_produkte: 0, anzahl_mit_unterschied: 0, anzahl_ohne_unterschied: 0,
    anzahl_unter_ziel: 0, anzahl_im_ziel: 0, anzahl_ohne_ziel: 0,
    anzahl_ohne_ek: 0, anzahl_ohne_stueckrechnung: 0,
    mehrkosten_jahr: null, entlastung_jahr: null,
    anzahl_klassenwechsel: 0, anzahl_unsicher: 0,
    rechenweg: null, hinweis_werbung: null,
    nicht_bewertbar_grund: grund,
  };
}

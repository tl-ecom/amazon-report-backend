// strategie_lauf.ts — Schritt 4 (Engine-Lauf + Live-Auswertung über echte Pulse-Daten).
// Verdichtet vorhandene Daten (asins + produkt_uebersicht) zu AsinSnapshots und
// fährt die REINE Rule Engine (strategie.ts) darüber. Die Definitionen/Schwellen
// kommen aus config/strategy-definitions.ts (kanonisch, vom Coach gefüllt) und
// werden der Engine hereingereicht — die Engine bleibt DB-/netzwerkfrei.
//
// Zwei Einstiege:
//   * strategieUebersicht(read)  — Live-Urteil OHNE Schreiben (für die Oberfläche).
//   * laufeStrategie(write)       — persistiert Vorschläge + Korridor-Beobachtungen
//                                   (Audit-Trail + Benchmark-Datengrundlage) und
//                                   spiegelt die Config in die DB.
//
// Ehrlichkeit: nicht verfügbare Kennzahlen (acos/tacos/cvr/bestandsreichweite —
// Ads nicht verbunden, Traffic/Bestand je ASIN nicht verdrahtet) bleiben null.
// DB/Stück ist derzeit Rohertrag/Stück (Gebühren noch nicht je ASIN).

import { STRATEGIE_DEFINITIONEN, VORSCHLAG_SCHWELLEN } from "../../../config/strategy-definitions.ts";
import type { Rolle } from "../../../config/strategy-definitions.ts";
import { type AsinSnapshot, evaluate, type Finding, vorschlagRolle } from "./strategie.ts";

const TAG = 86_400_000;

// --- reine Helfer (unit-getestet) ---

export interface AsinAgg {
  asin: string;
  produktname: string | null;
  erstmals_gesehen: string | null;
  umsatz: number;
  einheiten: number;
  rohertrag: number | null;
  umsatz_vorperiode: number | null;
  portfolio_umsatz: number;
}

/** Baut aus den Aggregaten einer ASIN einen Snapshot. Fehlende Werte → null. */
export function baueSnapshot(agg: AsinAgg, stichtag: string): AsinSnapshot {
  const db_stueck = agg.rohertrag != null && agg.einheiten > 0 ? agg.rohertrag / agg.einheiten : null;
  const anteil = agg.portfolio_umsatz > 0 ? (agg.umsatz / agg.portfolio_umsatz) * 100 : null;
  const trend = agg.umsatz_vorperiode != null && agg.umsatz_vorperiode > 0
    ? (agg.umsatz - agg.umsatz_vorperiode) / agg.umsatz_vorperiode
    : null;
  return {
    asin: agg.asin,
    stichtag,
    kennzahlen: {
      umsatz: agg.umsatz,
      einheiten: agg.einheiten,
      deckungsbeitrag_stueck: db_stueck,
      umsatzanteil_portfolio: anteil == null ? null : Math.round(anteil * 10) / 10,
      // ehrlich unbekannt: acos, tacos, cvr, bestandsreichweite
    },
    erstmals_gesehen: agg.erstmals_gesehen,
    umsatz_trend: trend == null ? null : Math.round(trend * 100) / 100,
  };
}

export interface AsinFinding extends Finding {
  asin: string;
  produktname: string | null;
}

const SEV: Record<string, number> = { hoch: 0, mittel: 1, niedrig: 2 };

/** Wochenausgabe = die 3 wichtigsten Findings ÜBER ALLE ASINs (gleiche Priorisierung
 *  wie in der Engine: Entscheidungs-Ereignis → Schweregrad → Abweichungsgröße). */
export function wochenausgabe(
  proAsin: Array<{ asin: string; produktname: string | null; findings: Finding[] }>,
): AsinFinding[] {
  const alle: AsinFinding[] = [];
  for (const p of proAsin) {
    for (const f of p.findings) alle.push({ ...f, asin: p.asin, produktname: p.produktname });
  }
  alle.sort((a, b) => {
    const ra = a.kennzahl === "review" ? 0 : 1;
    const rb = b.kennzahl === "review" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (SEV[a.severity] !== SEV[b.severity]) return SEV[a.severity] - SEV[b.severity];
    return b.magnitude - a.magnitude;
  });
  return alle.slice(0, 3);
}

/** Ist mindestens eine Rolle sinnvoll konfiguriert (leading_kpi + Korridor)? */
export function istKonfiguriert(): boolean {
  return Object.values(STRATEGIE_DEFINITIONEN).some(
    (d) => d.leading_kpi != null && (d.korridor.min != null || d.korridor.max != null),
  );
}

// --- Snapshots aus vorhandenen Daten ---

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Liest produkt_uebersicht (aktuelles & vorheriges 30-Tage-Fenster) und baut
 * Snapshots — aber NUR für RELEVANTE ASINs: solche mit Umsatz im Fenster ODER
 * mit bereits fester Rolle. Der Katalog kann Tausende Karteileichen enthalten
 * (e-One: 1562 ASINs, ~4 mit Umsatz); die Strategie betrifft nur, was läuft.
 */
async function ladeSnapshots(
  supabase: any,
  tenant_id: string,
): Promise<{ snapshots: AsinSnapshot[]; namen: Map<string, string | null>; stichtag: string }> {
  const jetzt = Date.now();
  const curVon = iso(jetzt - 29 * TAG);
  const curBis = iso(jetzt);
  const prevVon = iso(jetzt - 59 * TAG);
  const prevBis = iso(jetzt - 30 * TAG);

  const [asinsRes, curRes, prevRes, aktivRes] = await Promise.all([
    supabase.from("asins").select("asin, produktname, erstmals_gesehen").eq("tenant_id", tenant_id),
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: curVon, p_bis: curBis }),
    supabase.rpc("produkt_uebersicht", { p_tenant: tenant_id, p_von: prevVon, p_bis: prevBis }),
    supabase.from("asin_strategien").select("asin").eq("tenant_id", tenant_id).is("gueltig_bis", null),
  ]);
  if (asinsRes.error) throw new Error(`asins: ${asinsRes.error.message}`);
  if (curRes.error) throw new Error(`produkt_uebersicht: ${curRes.error.message}`);
  if (prevRes.error) throw new Error(`produkt_uebersicht(prev): ${prevRes.error.message}`);
  if (aktivRes.error) throw new Error(`asin_strategien: ${aktivRes.error.message}`);

  const cur = new Map<string, any>();
  for (const r of curRes.data ?? []) cur.set(r.asin, r);
  const prev = new Map<string, number>();
  for (const r of prevRes.data ?? []) prev.set(r.asin, (Number(r.umsatz_cents) || 0) / 100);
  const portfolio = [...cur.values()].reduce((s, r) => s + (Number(r.umsatz_cents) || 0) / 100, 0);

  // Stammdaten (Name, Produktalter) als Nachschlage-Map — nicht als Snapshot-Basis.
  const stamm = new Map<string, { name: string | null; erstmals: string | null }>();
  for (const a of asinsRes.data ?? []) {
    stamm.set(a.asin, { name: a.produktname ?? null, erstmals: a.erstmals_gesehen ? String(a.erstmals_gesehen).slice(0, 10) : null });
  }

  // Relevante ASINs = Umsatz im Fenster ∪ bereits zugeordnet.
  const relevant = new Set<string>(cur.keys());
  for (const z of aktivRes.data ?? []) relevant.add(z.asin);

  const namen = new Map<string, string | null>();
  const snapshots: AsinSnapshot[] = [];
  for (const asin of relevant) {
    const st = stamm.get(asin) ?? { name: null, erstmals: null };
    namen.set(asin, st.name);
    const c = cur.get(asin);
    const umsatz = c ? (Number(c.umsatz_cents) || 0) / 100 : 0;
    const einheiten = c ? Number(c.einheiten) || 0 : 0;
    const hatEk = c ? (Number(c.einheiten_mit_ek) || 0) > 0 : false;
    const rohertrag = hatEk ? umsatz - (Number(c.wareneinsatz_cents) || 0) / 100 : null;
    snapshots.push(baueSnapshot({
      asin,
      produktname: st.name,
      erstmals_gesehen: st.erstmals,
      umsatz: Math.round(umsatz * 100) / 100,
      einheiten,
      rohertrag: rohertrag == null ? null : Math.round(rohertrag * 100) / 100,
      umsatz_vorperiode: prev.has(asin) ? prev.get(asin)! : null,
      portfolio_umsatz: portfolio,
    }, curBis));
  }
  return { snapshots, namen, stichtag: curBis };
}

// --- Read: Live-Urteil (keine Schreibvorgänge) ---

export async function strategieUebersicht(supabase: any, tenant_id: string): Promise<unknown> {
  const heute = new Date().toISOString().slice(0, 10);
  const [{ snapshots, namen }, zuord, offene] = await Promise.all([
    ladeSnapshots(supabase, tenant_id),
    supabase.from("asin_strategien").select("*").eq("tenant_id", tenant_id).is("gueltig_bis", null),
    supabase.from("strategie_vorschlaege").select("*").eq("tenant_id", tenant_id).eq("status", "offen"),
  ]);
  if (zuord.error) throw new Error(`asin_strategien: ${zuord.error.message}`);
  if (offene.error) throw new Error(`strategie_vorschlaege: ${offene.error.message}`);

  const aktivMap = new Map<string, any>();
  for (const z of zuord.data ?? []) aktivMap.set(z.asin, z);

  const produkte: any[] = [];
  const findingsProAsin: Array<{ asin: string; produktname: string | null; findings: Finding[] }> = [];

  for (const s of snapshots) {
    const name = namen.get(s.asin) ?? null;
    const aktiv = aktivMap.get(s.asin);
    if (aktiv) {
      const def = STRATEGIE_DEFINITIONEN[aktiv.rolle as Rolle];
      const erg = evaluate(
        s,
        { rolle: aktiv.rolle, gueltig_ab: String(aktiv.gueltig_ab).slice(0, 10), review_faellig: aktiv.review_faellig },
        def,
        heute,
        def?.max_dauer_tage ?? null,
      );
      findingsProAsin.push({ asin: s.asin, produktname: name, findings: erg.findings });
      produkte.push({
        asin: s.asin,
        produktname: name,
        aktive_strategie: aktiv,
        evaluation: {
          ergebnis: erg.beobachtung.ergebnis,
          leading_kpi: erg.beobachtung.leading_kpi,
          leading_wert: erg.beobachtung.leading_wert,
          findings: erg.findings,
          findings_gesamt: erg.findings_gesamt,
          kein_handlungsbedarf: erg.kein_handlungsbedarf,
          hinweis: erg.hinweis,
        },
        vorschlag: null,
      });
    } else {
      const v = vorschlagRolle(s, VORSCHLAG_SCHWELLEN);
      produkte.push({ asin: s.asin, produktname: name, aktive_strategie: null, evaluation: null, vorschlag: v });
    }
  }

  return {
    stichtag: heute,
    konfiguriert: istKonfiguriert(),
    wochenausgabe: wochenausgabe(findingsProAsin),
    produkte,
    vorschlaege_offen: offene.data ?? [],
    definitionen: Object.values(STRATEGIE_DEFINITIONEN),
  };
}

// --- Write: Lauf persistiert Vorschläge + Beobachtungen, spiegelt Config ---

/** Persistiert einen Vorschlag; ein etwaiger offener für die ASIN wird entwertet
 *  (Partial-Unique erlaubt nur einen offenen je ASIN). */
export async function speichereVorschlag(
  supabase: any,
  tenant_id: string,
  v: { asin: string; rolle: string; konfidenz: string; begruendung: string; basis: unknown },
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("strategie_vorschlaege")
    .update({ status: "ersetzt", entschieden_am: now })
    .eq("tenant_id", tenant_id).eq("asin", v.asin).eq("status", "offen");
  const { error } = await supabase.from("strategie_vorschlaege").insert({
    tenant_id, asin: v.asin, vorgeschlagene_rolle: v.rolle, konfidenz: v.konfidenz,
    begruendung: v.begruendung, basis: v.basis ?? {}, status: "offen",
  });
  if (error) throw new Error(`Vorschlag speichern: ${error.message}`);
}

export async function laufeStrategie(supabase: any, tenant_id: string, _user_id: string): Promise<unknown> {
  // 1) Config → DB spiegeln (fürs Anzeigen/Integrität; Engine nutzt weiter die Config direkt).
  const defRows = Object.values(STRATEGIE_DEFINITIONEN).map((d) => ({
    rolle: d.rolle, leading_kpi: d.leading_kpi, korridor: d.korridor,
    alert_regeln: d.alert_regeln, muted_metrics: d.muted_metrics,
    max_dauer_tage: d.max_dauer_tage, beschreibung: d.beschreibung, updated_at: new Date().toISOString(),
  }));
  await supabase.from("strategie_definitionen").upsert(defRows, { onConflict: "rolle" });

  const heute = new Date().toISOString().slice(0, 10);
  const { snapshots } = await ladeSnapshots(supabase, tenant_id);
  const zuord = await supabase.from("asin_strategien")
    .select("asin, rolle, gueltig_ab, review_faellig").eq("tenant_id", tenant_id).is("gueltig_bis", null);
  if (zuord.error) throw new Error(`asin_strategien: ${zuord.error.message}`);
  const aktivMap = new Map<string, any>();
  for (const z of zuord.data ?? []) aktivMap.set(z.asin, z);

  const beobRows: any[] = [];
  let vorschlaege = 0;
  for (const s of snapshots) {
    const aktiv = aktivMap.get(s.asin);
    if (aktiv) {
      const def = STRATEGIE_DEFINITIONEN[aktiv.rolle as Rolle];
      const erg = evaluate(
        s,
        { rolle: aktiv.rolle, gueltig_ab: String(aktiv.gueltig_ab).slice(0, 10), review_faellig: aktiv.review_faellig },
        def, heute, def?.max_dauer_tage ?? null,
      );
      const b = erg.beobachtung;
      beobRows.push({
        tenant_id, asin: s.asin, rolle: b.rolle, beobachtet_am: b.beobachtet_am,
        leading_kpi: b.leading_kpi, leading_wert: b.leading_wert, kennzahlen: b.kennzahlen,
        preisklasse: b.preisklasse, wochen_seit_launch: b.wochen_seit_launch, ergebnis: b.ergebnis,
      });
    } else {
      const v = vorschlagRolle(s, VORSCHLAG_SCHWELLEN);
      await speichereVorschlag(supabase, tenant_id, { asin: s.asin, rolle: v.rolle, konfidenz: v.konfidenz, begruendung: v.begruendung, basis: v.basis });
      vorschlaege++;
    }
  }

  let beobachtungen = 0;
  if (beobRows.length) {
    const { error } = await supabase.from("korridor_beobachtungen").upsert(beobRows, { onConflict: "tenant_id,asin,beobachtet_am" });
    if (error) throw new Error(`korridor_beobachtungen: ${error.message}`);
    beobachtungen = beobRows.length;
  }

  return { ok: true, asins: snapshots.length, beobachtungen, vorschlaege_erzeugt: vorschlaege, stichtag: heute };
}

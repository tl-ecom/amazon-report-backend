// sellerboard_bestand_import.ts — DB-Schicht fuer die Sellerboard-Bestandsquelle.
// Reine Parserlogik liegt in sellerboard_bestand.ts (unit-getestet).
//
// Ablauf (Hand- und Cron-Lauf identisch, es ist dieselbe Funktion):
//   Feed-URL aus dem Vault lesen -> CSV laden -> Spalten erkennen -> SKU/ASIN
//   zuordnen -> bestand_extern ersetzen -> Tagesstand in bestand_extern_verlauf
//   -> Status in bestand_verbindungen vermerken.
//
// Die URL enthaelt ein Zugriffs-Token. Sie liegt NUR im Vault; die Tabelle
// traegt die Secret-Referenz. Sie wird nie zurueckgegeben — auch nicht
// verkuerzt. Das Frontend erfaehrt nur, OB ein Link hinterlegt ist.
//
// Ehrlichkeit: „Verbindung testen" schreibt nichts und meldet trotzdem alles,
// was der Sync spaeter tun wuerde (erkannte Spalten, uebersprungene Zeilen,
// nicht zuordenbare SKUs). Fehler landen in `letzter_fehler`, damit die
// Sync-Wache sie sieht — ein stiller Ausfall ist der teuerste.

import { istFeedNochNichtBereit, KLASSE, LAGERART_LABEL, type Lagerart, parseBestandCsv, type SpaltenErkennung } from "./sellerboard_bestand.ts";
import { ladeEkJeAsin } from "./bestand_gesamt.ts";

export const QUELLE = "sellerboard";
const FEED_TIMEOUT_MS = 45_000;
const MAX_FEHLER_LAENGE = 300;

export interface VerbindungStatus {
  connected: boolean;
  /** 'nicht_verbunden' | 'ungeprueft' | 'verbunden' | 'fehler' */
  status: string;
  hat_url: boolean;
  auto_sync: boolean;
  intervall_stunden: number;
  zuletzt_versuch: string | null;
  zuletzt_erfolg: string | null;
  letzter_fehler: string | null;
  zeilen_zuletzt: number | null;
  erkannte_spalten: SpaltenErkennung | null;
  /** Summe je Lagerart aus dem letzten erfolgreichen Lauf. */
  je_lagerart: Record<string, number> | null;
}

export interface SyncErgebnis {
  /** true = nur geprueft, es wurde NICHTS geschrieben. */
  vorschau: boolean;
  erkannt: SpaltenErkennung;
  spalten: string[];
  /** Produkt-x-Ort-Zeilen mit lesbarer Kennung. */
  gelesen: number;
  uebersprungen: number;
  /** Zeilen mit zugeordneter ASIN — nur diese fliessen in die Bestandslogik. */
  zugeordnet: number;
  nicht_zuordenbar: string[];
  geschrieben: number;
  /** Summe je Lagerart (nur zugeordnete Zeilen mit Menge). */
  je_lagerart: Array<{ lagerart: Lagerart; label: string; klasse: string; menge: number; zeilen: number }>;
  /** Amazon-Klasse im Feed: wird nur gezaehlt, wenn die SP-API nichts liefert. */
  amazon_klasse_im_feed: boolean;
  warnungen: string[];
  stand: string;
}

// --- Verbindung ---------------------------------------------------------------

async function ladeVerbindung(supabase: any, tenant_id: string): Promise<any | null> {
  const { data, error } = await supabase.from("bestand_verbindungen")
    .select("url_secret, status, auto_sync, intervall_stunden, zuletzt_versuch, zuletzt_erfolg, letzter_fehler, zeilen_zuletzt, erkannte_spalten, je_lagerart")
    .eq("tenant_id", tenant_id).eq("quelle", QUELLE).maybeSingle();
  if (error) throw new Error(`bestand_verbindungen: ${error.message}`);
  return data ?? null;
}

async function schreibeVerbindung(supabase: any, tenant_id: string, satz: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("bestand_verbindungen")
    .upsert({ tenant_id, quelle: QUELLE, ...satz, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,quelle" });
  if (error) throw new Error(`bestand_verbindungen schreiben: ${error.message}`);
}

/** Status fuer die Ressource `verbindungen`. Gibt die URL NIE zurueck. */
export async function bestandVerbindungStatus(supabase: any, tenant_id: string): Promise<VerbindungStatus> {
  const v = await ladeVerbindung(supabase, tenant_id);
  if (!v) {
    return {
      connected: false, status: "nicht_verbunden", hat_url: false, auto_sync: true, intervall_stunden: 24,
      zuletzt_versuch: null, zuletzt_erfolg: null, letzter_fehler: null, zeilen_zuletzt: null,
      erkannte_spalten: null, je_lagerart: null,
    };
  }
  return {
    connected: v.status === "verbunden",
    status: String(v.status ?? "ungeprueft"),
    hat_url: Boolean(v.url_secret),
    auto_sync: v.auto_sync !== false,
    intervall_stunden: Number(v.intervall_stunden) || 24,
    zuletzt_versuch: v.zuletzt_versuch ?? null,
    zuletzt_erfolg: v.zuletzt_erfolg ?? null,
    letzter_fehler: v.letzter_fehler ?? null,
    zeilen_zuletzt: v.zeilen_zuletzt ?? null,
    erkannte_spalten: v.erkannte_spalten ?? null,
    je_lagerart: v.je_lagerart ?? null,
  };
}

/** Feed-URL im Vault ablegen; in der Tabelle steht nur die Referenz. */
export async function speichereBestandUrl(supabase: any, tenant_id: string, url: string): Promise<{ ok: true }> {
  const u = String(url ?? "").trim();
  if (!/^https:\/\//i.test(u)) throw new Error("Bitte eine vollständige https-Adresse eintragen.");
  if (u.length > 2000) throw new Error("Die Adresse ist ungewöhnlich lang — bitte den Export-Link aus Sellerboard prüfen.");
  const { data: secretId, error } = await supabase.rpc("upsert_vault_secret", {
    p_name: `sellerboard_bestand_${tenant_id}`, p_secret: u,
  });
  if (error) throw new Error(`Link speichern: ${error.message}`);
  await schreibeVerbindung(supabase, tenant_id, { url_secret: secretId, status: "ungeprueft", letzter_fehler: null });
  return { ok: true };
}

export async function setzeBestandEinstellungen(
  supabase: any, tenant_id: string, args: { auto_sync?: unknown; intervall_stunden?: unknown },
): Promise<{ ok: true }> {
  const satz: Record<string, unknown> = {};
  if ("auto_sync" in args) satz.auto_sync = args.auto_sync === true || args.auto_sync === "true";
  if ("intervall_stunden" in args) {
    const n = Math.round(Number(args.intervall_stunden));
    if (!Number.isFinite(n) || n < 1 || n > 744) throw new Error("Intervall: bitte 1 bis 744 Stunden angeben (24 = täglich, 168 = wöchentlich, 720 = monatlich).");
    satz.intervall_stunden = n;
  }
  if (Object.keys(satz).length === 0) throw new Error("Nichts zu ändern.");
  const v = await ladeVerbindung(supabase, tenant_id);
  await schreibeVerbindung(supabase, tenant_id, { ...satz, ...(v ? {} : { status: "nicht_verbunden" }) });
  return { ok: true };
}

/**
 * Verbindung trennen: Bestandszeilen dieser Quelle loeschen, Referenz entfernen,
 * das Secret im Vault mit einem Platzhalter ueberschreiben (es gibt keine
 * Loesch-RPC, und ein totes Token soll nicht liegen bleiben).
 * Der Tagesverlauf bleibt — er ist Historie und enthaelt kein Token.
 */
export async function trenneBestandVerbindung(supabase: any, tenant_id: string): Promise<{ ok: true }> {
  const v = await ladeVerbindung(supabase, tenant_id);
  if (v?.url_secret) {
    await supabase.rpc("upsert_vault_secret", { p_name: `sellerboard_bestand_${tenant_id}`, p_secret: "entfernt" });
  }
  const { error: dErr } = await supabase.from("bestand_extern").delete().eq("tenant_id", tenant_id).eq("quelle", QUELLE);
  if (dErr) throw new Error(`Bestände löschen: ${dErr.message}`);
  await schreibeVerbindung(supabase, tenant_id, {
    url_secret: null, status: "nicht_verbunden", letzter_fehler: null, zeilen_zuletzt: null,
    erkannte_spalten: null, je_lagerart: null,
  });
  return { ok: true };
}

// --- Feed laden ---------------------------------------------------------------

async function ladeFeed(supabase: any, tenant_id: string): Promise<string> {
  const v = await ladeVerbindung(supabase, tenant_id);
  if (!v?.url_secret) throw new Error("Es ist kein Sellerboard-Bestands-Link hinterlegt.");
  const { data: url, error } = await supabase.rpc("read_vault_secret", { p_secret_id: v.url_secret });
  if (error || !url || String(url) === "entfernt") throw new Error("Hinterlegter Link konnte nicht gelesen werden.");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  let text: string;
  try {
    const resp = await fetch(String(url), { redirect: "follow", signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Sellerboard antwortete mit HTTP ${resp.status}`);
    text = await resp.text();
  } catch (err) {
    const m = String((err as Error)?.message ?? err);
    throw new Error(/abort/i.test(m) ? `Abruf fehlgeschlagen: Zeitüberschreitung nach ${FEED_TIMEOUT_MS / 1000} s` : `Abruf fehlgeschlagen: ${m}`);
  } finally {
    clearTimeout(timer);
  }
  // Eine HTML-Loginseite statt CSV ist der haeufigste Fall bei abgelaufenen Links.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error("Der Link lieferte eine Webseite statt einer CSV — bitte den Export-Link in Sellerboard neu kopieren.");
  }
  // Sellerboard baut den Export erst beim Abruf. Bis er fertig ist, kommt eine
  // Textzeile statt CSV. Das ist kein Verbindungsfehler — nur noch nicht fertig.
  if (istFeedNochNichtBereit(text)) throw new FeedNochNichtBereit();
  return text;
}

export class FeedNochNichtBereit extends Error {
  constructor() {
    super("Sellerboard erstellt den Export gerade („Report not ready“). In einigen Minuten erneut versuchen — der Auto-Sync wiederholt es von selbst.");
    this.name = "FeedNochNichtBereit";
  }
}

/**
 * „Noch nicht bereit" wird vermerkt, zaehlt aber weder als Versuch noch als
 * Fehler: `zuletzt_versuch` bleibt stehen, damit der stuendliche Cron beim
 * naechsten Lauf erneut anklopft statt erst nach dem vollen Intervall.
 */
async function merkeNochNichtBereit(supabase: any, tenant_id: string, err: unknown): Promise<boolean> {
  if (!(err instanceof FeedNochNichtBereit)) return false;
  await schreibeVerbindung(supabase, tenant_id, { letzter_fehler: err.message.slice(0, MAX_FEHLER_LAENGE) }).catch(() => {});
  return true;
}

// --- Zuordnung ------------------------------------------------------------------

async function ladeKennungen(supabase: any, tenant_id: string): Promise<{ skuZuAsin: Map<string, string>; asinZuSkus: Map<string, Set<string>> }> {
  const [ordersRes, lagerRes, verlaufRes] = await Promise.all([
    supabase.from("orders_history").select("sku, asin").eq("tenant_id", tenant_id).not("sku", "is", null).not("asin", "is", null),
    supabase.from("fba_bestand").select("sku, asin").eq("tenant_id", tenant_id).not("asin", "is", null),
    supabase.from("fba_bestand_verlauf").select("sku, asin").eq("tenant_id", tenant_id).not("asin", "is", null),
  ]);
  const skuZuAsin = new Map<string, string>();
  const asinZuSkus = new Map<string, Set<string>>();
  for (const quelle of [lagerRes, ordersRes, verlaufRes]) {
    for (const r of (quelle.data ?? []) as any[]) {
      const sku = String(r.sku ?? "").trim();
      const asin = String(r.asin ?? "").trim().toUpperCase();
      if (!sku || !asin) continue;
      if (!skuZuAsin.has(sku)) skuZuAsin.set(sku, asin);
      const s = asinZuSkus.get(asin) ?? new Set<string>();
      s.add(sku);
      asinZuSkus.set(asin, s);
    }
  }
  return { skuZuAsin, asinZuSkus };
}

interface DbZeile {
  tenant_id: string; quelle: string; marketplace_id: string | null; marktplatz_roh: string;
  sku: string; asin: string; lagerart: Lagerart; lagername: string; menge: number | null;
  zuordnung: "sku" | "asin" | "keine"; produktname: string | null; stand: string; sync_id: string;
}

/**
 * Feed verarbeiten: parsen, zuordnen, optional schreiben. `schreiben=false`
 * liefert die Pruefung — gleiche Zahlen, ohne Nebenwirkung.
 */
export async function verarbeiteBestandCsv(
  supabase: any, tenant_id: string, csv: string, schreiben: boolean,
): Promise<SyncErgebnis> {
  const p = parseBestandCsv(csv);
  const stand = new Date().toISOString();
  const basis: SyncErgebnis = {
    vorschau: !schreiben, erkannt: p.erkannt, spalten: p.spalten, gelesen: p.zeilen.length,
    uebersprungen: p.uebersprungen, zugeordnet: 0, nicht_zuordenbar: [], geschrieben: 0,
    je_lagerart: [], amazon_klasse_im_feed: p.erkannt.bestand.some((b) => b.klasse === "amazon"),
    warnungen: [...p.warnungen], stand,
  };
  if (p.zeilen.length === 0) return basis;

  const { skuZuAsin, asinZuSkus } = await ladeKennungen(supabase, tenant_id);
  const syncId = crypto.randomUUID();
  const proSchluessel = new Map<string, DbZeile>();
  const fehlend = new Set<string>();

  for (const z of p.zeilen) {
    // Bevorzugt ueber SKU (eindeutig je Konto), sonst ueber ASIN, sofern eindeutig.
    // Sellerboard fuehrt je ASIN ALLE SKUs kommagetrennt in einer Zelle
    // („8I-4QHO-FU55, RH-PLUM-4ER4, V5-W2LS-X48K") — jede einzeln probieren.
    let asin = "";
    let sku = z.sku ?? "";
    let zuordnung: DbZeile["zuordnung"] = "keine";
    const skuTreffer = sku.split(/\s*,\s*/).map((s) => s.trim()).find((s) => s && skuZuAsin.has(s));
    if (skuTreffer) { asin = skuZuAsin.get(skuTreffer)!; zuordnung = "sku"; }
    else if (z.asin) {
      asin = z.asin; zuordnung = "asin";
      const skus = asinZuSkus.get(asin);
      if (!sku && skus && skus.size === 1) sku = [...skus][0];
    } else if (sku) {
      fehlend.add(sku);
    }
    // Feed nennt SKU und ASIN, Pulse kennt die SKU nicht: die ASIN des Feeds
    // gilt — der Verkaeufer weiss, was er lagert.
    if (!asin && z.asin) { asin = z.asin; zuordnung = "asin"; }

    const key = [z.marktplatz_roh, sku, asin, z.lagerart, z.lagername].join("|");
    proSchluessel.set(key, {
      tenant_id, quelle: QUELLE, marketplace_id: z.marketplace_id, marktplatz_roh: z.marktplatz_roh,
      sku, asin, lagerart: z.lagerart, lagername: z.lagername, menge: z.menge,
      zuordnung, produktname: z.produktname, stand, sync_id: syncId,
    });
  }

  const rows = [...proSchluessel.values()];
  basis.zugeordnet = rows.filter((r) => r.asin).length;
  basis.nicht_zuordenbar = [...fehlend].slice(0, 25);
  if (fehlend.size > 0) {
    basis.warnungen.push(`${fehlend.size} SKU(s) ohne bekannte ASIN — diese Produkte wurden nie verkauft oder liegen nicht im Amazon-Lagerbericht; sie werden gespeichert, aber nicht gezählt.`);
  }

  const je = new Map<Lagerart, { menge: number; zeilen: number }>();
  for (const r of rows) {
    if (!r.asin || r.menge == null) continue;
    const e = je.get(r.lagerart) ?? { menge: 0, zeilen: 0 };
    e.menge += r.menge; e.zeilen += 1;
    je.set(r.lagerart, e);
  }
  basis.je_lagerart = [...je.entries()].map(([lagerart, e]) => ({
    lagerart, label: LAGERART_LABEL[lagerart], klasse: KLASSE[lagerart], menge: e.menge, zeilen: e.zeilen,
  })).sort((a, b) => b.menge - a.menge);

  if (basis.amazon_klasse_im_feed) {
    basis.warnungen.push("Der Feed enthält FBA-/Inbound-Spalten. Dafür ist die Amazon SP-API die primäre Quelle; diese Spalten werden nur gezählt, wenn Amazon keine Bestandsdaten liefert.");
  }
  if (!schreiben || rows.length === 0) return basis;

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from("bestand_extern")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "tenant_id,quelle,marktplatz_roh,sku,asin,lagerart,lagername" });
    if (error) throw new Error(`Bestand schreiben: ${error.message}`);
  }
  // Was im Feed nicht mehr steht, gibt es nicht mehr: alte Zeilen dieser Quelle raus.
  const { error: altErr } = await supabase.from("bestand_extern").delete()
    .eq("tenant_id", tenant_id).eq("quelle", QUELLE).neq("sync_id", syncId);
  if (altErr) throw new Error(`Alte Bestände entfernen: ${altErr.message}`);
  basis.geschrieben = rows.length;

  await schreibeVerlauf(supabase, tenant_id, rows, stand);
  return basis;
}

/** Tagesstand fuer Working-Capital-Auswertungen ueber die Zeit. Ein Satz je Tag. */
async function schreibeVerlauf(supabase: any, tenant_id: string, rows: DbZeile[], stand: string): Promise<void> {
  const ek = await ladeEkJeAsin(supabase, tenant_id);
  const datum = stand.slice(0, 10);
  const verlauf = rows.filter((r) => r.asin && r.menge != null).map((r) => {
    const ekC = ek.get(r.asin) ?? null;
    return {
      tenant_id, datum, quelle: r.quelle, marktplatz_roh: r.marktplatz_roh, sku: r.sku, asin: r.asin,
      lagerart: r.lagerart, lagername: r.lagername, menge: r.menge, ek_cents: ekC,
      wert_cents: ekC == null || r.menge == null ? null : r.menge * ekC, updated_at: stand,
    };
  });
  const BATCH = 500;
  for (let i = 0; i < verlauf.length; i += BATCH) {
    const { error } = await supabase.from("bestand_extern_verlauf")
      .upsert(verlauf.slice(i, i + BATCH), { onConflict: "tenant_id,datum,quelle,marktplatz_roh,sku,asin,lagerart,lagername" });
    if (error) throw new Error(`Bestandsverlauf schreiben: ${error.message}`);
  }
}

// --- Oeffentliche Laeufe ------------------------------------------------------------

/** „Verbindung testen": laden + pruefen, nichts schreiben. Vermerkt den Versuch. */
export async function pruefeBestandVerbindung(supabase: any, tenant_id: string): Promise<SyncErgebnis> {
  const jetzt = new Date().toISOString();
  try {
    const csv = await ladeFeed(supabase, tenant_id);
    const erg = await verarbeiteBestandCsv(supabase, tenant_id, csv, false);
    const ok = erg.zugeordnet > 0;
    await schreibeVerbindung(supabase, tenant_id, {
      zuletzt_versuch: jetzt,
      status: ok ? "verbunden" : "fehler",
      letzter_fehler: ok ? null : (erg.warnungen[0] ?? "Keine verwertbaren Zeilen im Feed").slice(0, MAX_FEHLER_LAENGE),
      erkannte_spalten: erg.erkannt,
    });
    return erg;
  } catch (err) {
    if (await merkeNochNichtBereit(supabase, tenant_id, err)) throw err;
    const m = String((err as Error)?.message ?? err);
    await schreibeVerbindung(supabase, tenant_id, { zuletzt_versuch: jetzt, status: "fehler", letzter_fehler: m.slice(0, MAX_FEHLER_LAENGE) }).catch(() => {});
    throw err;
  }
}

/** Voller Sync: laden, schreiben, Status vermerken. Von Knopf UND Cron benutzt. */
export async function syncSellerboardBestand(supabase: any, tenant_id: string): Promise<SyncErgebnis> {
  const jetzt = new Date().toISOString();
  try {
    const csv = await ladeFeed(supabase, tenant_id);
    const erg = await verarbeiteBestandCsv(supabase, tenant_id, csv, true);
    if (erg.zugeordnet === 0) {
      // Ein Feed ohne eine einzige zuordenbare Zeile ist kein Erfolg — aber die
      // alten Zeilen sind schon ersetzt. Das ist richtig so: der Feed IST leer.
      const grund = (erg.warnungen[0] ?? "Keine verwertbaren Zeilen im Feed").slice(0, MAX_FEHLER_LAENGE);
      await schreibeVerbindung(supabase, tenant_id, {
        zuletzt_versuch: jetzt, status: "fehler", letzter_fehler: grund, erkannte_spalten: erg.erkannt, zeilen_zuletzt: 0,
      });
      return erg;
    }
    const je: Record<string, number> = {};
    for (const j of erg.je_lagerart) je[j.lagerart] = j.menge;
    await schreibeVerbindung(supabase, tenant_id, {
      zuletzt_versuch: jetzt, zuletzt_erfolg: jetzt, status: "verbunden", letzter_fehler: null,
      erkannte_spalten: erg.erkannt, zeilen_zuletzt: erg.geschrieben, je_lagerart: je,
    });
    return erg;
  } catch (err) {
    if (await merkeNochNichtBereit(supabase, tenant_id, err)) throw err;
    const m = String((err as Error)?.message ?? err);
    await schreibeVerbindung(supabase, tenant_id, { zuletzt_versuch: jetzt, status: "fehler", letzter_fehler: m.slice(0, MAX_FEHLER_LAENGE) }).catch(() => {});
    throw err;
  }
}

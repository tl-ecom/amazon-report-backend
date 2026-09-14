// sqp.ts — Parser + Lesezugriffe für den Brand-Analytics Search Query Performance
// Report (GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT, ASIN-gefiltert).
// Rechnet je Suchanfrage: eigene CTR/CVR vs. Markt-CTR/CVR (+ Index) und den
// Kaufanteil der ASIN. "duenn" markiert Zeilen mit zu kleiner eigener Datenbasis.
//
// Ein Report gilt immer für EINE ASIN und EINEN Zeitraum. Amazon liefert ihn wie
// in Seller Central wahlweise wochen- oder monatsweise; die Grenzen müssen exakt
// auf der Periode liegen (Woche = Sonntag–Samstag, Monat = 1. bis Monatsletzter).
// Die Zeitraum-Helfer unten sind rein und deshalb testbar — sync-sqp benutzt
// dieselben, damit Anzeige und Abruf nie auseinanderlaufen.

const DUENN_IMPRESSIONS = 100; // eigene Impressions darunter => dünne Datenbasis
const DUENN_CLICKS = 10;

const TAG_MS = 86400000;

export type Periode = "WEEK" | "MONTH";

/**
 * Die EU-Marktplaetze, die ueber dieselbe Verbindung erreichbar sind.
 *
 * Ein Refresh-Token gilt fuer die ganze Region, nicht fuer ein Land. Was fehlt,
 * ist nur die Angabe, WELCHEN Marktplatz man meint — der Bericht lief deshalb
 * immer gegen den Marktplatz der Verbindung, also Deutschland.
 *
 * Voraussetzung bleibt, dass der Verkaeufer dort auch verkauft: Brand Analytics
 * gibt es nur fuer Marktplaetze mit eigenem Umsatz und eingetragener Marke.
 */
export const MARKTPLAETZE: Record<string, string> = {
  "A1PA6795UKMFR9": "Amazon.de",
  "A13V1IB3VIYZZH": "Amazon.fr",
  "APJ6JRA9NG5V4": "Amazon.it",
  "A1RKKUPIHCS9HS": "Amazon.es",
  "A1805IZSGTT6HS": "Amazon.nl",
  "A1F83G8C2ARO7P": "Amazon.co.uk",
  "AMEN7PMS3EDWL": "Amazon.com.be",
  "A1C3SOZRARQ6R3": "Amazon.pl",
  "A2NODRKZP88ZB9": "Amazon.se",
};

/** Name zum Marktplatz — unbekannte IDs behalten die ID, statt "unbekannt". */
export function marktplatzName(id: string | null | undefined): string {
  const s = String(id ?? "").trim();
  return MARKTPLAETZE[s] ?? (s || "—");
}

/**
 * Marktplatz-Eingabe pruefen. Akzeptiert die ID oder den Namen ("fr",
 * "Amazon.fr", "FR") — wer den Bericht fuer Frankreich will, soll nicht erst
 * eine 14-stellige Kennung nachschlagen muessen.
 *
 * null = nichts angegeben, dann gilt der Marktplatz der Verbindung.
 */
export function alsMarktplatz(v: unknown): string | null {
  const roh = String(v ?? "").trim();
  if (!roh) return null;
  if (MARKTPLAETZE[roh]) return roh;
  const gesucht = roh.toLowerCase().replace(/^amazon\./, "").replace(/^\./, "");
  for (const [id, name] of Object.entries(MARKTPLAETZE)) {
    const kurz = name.toLowerCase().replace("amazon.", "");
    if (kurz === gesucht || name.toLowerCase() === roh.toLowerCase()) return id;
  }
  throw new Error(
    `Marktplatz "${roh}" nicht erkannt. Erlaubt sind die IDs oder Kuerzel: `
    + Object.entries(MARKTPLAETZE).map(([id, n]) => `${n.replace("Amazon.", "")} (${id})`).join(", "),
  );
}

/** Nimmt beliebige Eingaben entgegen und fällt auf "WEEK" zurück. */
export function alsPeriode(v: unknown): Periode {
  return String(v ?? "").toUpperCase() === "MONTH" ? "MONTH" : "WEEK";
}

function tag(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) throw new Error(`Datum im Format YYYY-MM-DD erwartet, bekam: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Datum als 'YYYY-MM-DD' (UTC). */
export function isoTag(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface Zeitraum { von: string; bis: string }

/**
 * Legt ein beliebiges Datum auf die Grenzen SEINER Periode. Amazon lehnt
 * Zeiträume ab, die nicht auf der Periode liegen — deshalb normalisieren wir
 * jede Nutzereingabe hier, statt ihr zu vertrauen.
 */
export function zeitraumFuer(periode: Periode, datum: string): Zeitraum {
  const d = tag(datum);
  if (periode === "MONTH") {
    const von = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const bis = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { von: isoTag(von), bis: isoTag(bis) };
  }
  const von = new Date(d.getTime() - d.getUTCDay() * TAG_MS); // zurück auf Sonntag
  return { von: isoTag(von), bis: isoTag(new Date(von.getTime() + 6 * TAG_MS)) };
}

/** Der letzte VOLLSTÄNDIG abgeschlossene Zeitraum vor `heute`. */
export function letzterZeitraum(periode: Periode, heute?: string): Zeitraum {
  const d = tag(heute ?? isoTag(new Date()));
  if (periode === "MONTH") {
    // Tag 0 des laufenden Monats = letzter Tag des Vormonats.
    const letzterVormonat = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    return zeitraumFuer("MONTH", isoTag(letzterVormonat));
  }
  const letzterSamstag = new Date(d.getTime() - (d.getUTCDay() + 1) * TAG_MS);
  return zeitraumFuer("WEEK", isoTag(letzterSamstag));
}

/** Auswahlliste für die Oberfläche: die letzten `anzahl` fertigen Zeiträume, neueste zuerst. */
export function zeitraumListe(periode: Periode, anzahl: number, heute?: string): Zeitraum[] {
  const liste: Zeitraum[] = [];
  let z = letzterZeitraum(periode, heute);
  for (let i = 0; i < Math.max(0, anzahl); i++) {
    liste.push(z);
    const davor = new Date(tag(z.von).getTime() - TAG_MS); // ein Tag vor dem Anfang liegt in der Vorperiode
    z = zeitraumFuer(periode, isoTag(davor));
  }
  return liste;
}

const WOCHEN_AUSWAHL = 26; // ein halbes Jahr
const MONATE_AUSWAHL = 12;

function quote(zaehler: number, nenner: number): number | null {
  if (!nenner || nenner <= 0) return null;
  return zaehler / nenner; // Rohquotient (0..1)
}
function alsProzent(q: number | null): number | null {
  return q == null ? null : Math.round(q * 1000) / 10; // % mit 1 Nachkommastelle
}
function index(eigen: number | null, markt: number | null): number | null {
  // WICHTIG: aus den Rohquotienten, nicht aus gerundeten Prozenten.
  if (eigen == null || markt == null || markt <= 0) return null;
  return Math.round((eigen / markt) * 100) / 100;
}
function n(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

export interface SqpZeile {
  search_query: string;
  volume: number;
  eigene_ctr: number | null;
  markt_ctr: number | null;
  ctr_index: number | null;
  eigene_cvr: number | null;
  markt_cvr: number | null;
  cvr_index: number | null;
  kaufanteil: number | null; // % Anteil der ASIN an allen Käufen der Suchanfrage
  duenn: boolean;
}

/** Parst den ASIN-gefilterten SQP-Report zu Zeilen je Suchanfrage. Rein. */
export function parseSqpReport(report: any): SqpZeile[] {
  const rows: any[] = report?.dataByAsin ?? report?.dataByDepartmentAndSearchTerm ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const q = r?.searchQueryData ?? {};
    const imp = r?.impressionData ?? {};
    const clk = r?.clickData ?? {};
    const pur = r?.purchaseData ?? {};

    const asinImpr = n(imp.asinImpressionCount);
    const totalImpr = n(imp.totalQueryImpressionCount);
    const asinClicks = n(clk.asinClickCount);
    const totalClicks = n(clk.totalClickCount);
    const asinPurch = n(pur.asinPurchaseCount);
    const totalPurch = n(pur.totalPurchaseCount);

    const eigeneCtrQ = quote(asinClicks, asinImpr);
    const marktCtrQ = quote(totalClicks, totalImpr);
    const eigeneCvrQ = quote(asinPurch, asinClicks);
    const marktCvrQ = quote(totalPurch, totalClicks);
    // Kaufanteil aus Zählwerten (asinPurchaseShare ist uneinheitlich skaliert).
    const kaufanteil = alsProzent(quote(asinPurch, totalPurch));

    return {
      search_query: String(q.searchQuery ?? ""),
      volume: n(q.searchQueryVolume),
      eigene_ctr: alsProzent(eigeneCtrQ), markt_ctr: alsProzent(marktCtrQ), ctr_index: index(eigeneCtrQ, marktCtrQ),
      eigene_cvr: alsProzent(eigeneCvrQ), markt_cvr: alsProzent(marktCvrQ), cvr_index: index(eigeneCvrQ, marktCvrQ),
      kaufanteil,
      duenn: asinImpr < DUENN_IMPRESSIONS || asinClicks < DUENN_CLICKS,
    };
  }).filter((z) => z.search_query !== "");
}

/**
 * Stand eines Abrufs. "laeuft" heißt: angestoßen, noch kein Ergebnis. "leer"
 * heißt: Amazon hat geantwortet, aber ohne Suchanfragen — das ist etwas anderes
 * als "fehler" und die Oberfläche sagt es auch anders.
 */
export type LaufStatus = "laeuft" | "fertig" | "leer" | "fehler";

export interface Lauf {
  status: LaufStatus;
  meldung: string | null;
  gestartet: string | null;
  beendet: string | null;
}

export interface VorhandenerZeitraum extends Zeitraum {
  /** Marktplatz des Abrufs — dieselbe ASIN hat je Land andere Suchbegriffe. */
  marktplatz: string;
  marktplatz_name: string;
  periode: Periode;
  zeilen: number;
  aktualisiert: string | null;
  lauf: Lauf | null;
}

function alsLaufStatus(v: unknown): LaufStatus | null {
  const s = String(v ?? "");
  return s === "laeuft" || s === "fertig" || s === "leer" || s === "fehler" ? s : null;
}

/** Welche Zeiträume wurden für diese ASIN schon geholt oder versucht? */
async function vorhandeneZeitraeume(
  supabase: any, tenant_id: string, asin: string, marktplatz: string | null,
): Promise<VorhandenerZeitraum[]> {
  const { data, error } = await supabase.rpc("sqp_zeitraeume", {
    p_tenant: tenant_id, p_asin: asin, p_marktplatz: marktplatz,
  });
  if (error) throw new Error(`sqp zeitraeume: ${error.message}`);
  return (data ?? []).map((r: any) => {
    const status = alsLaufStatus(r.status);
    return {
      marktplatz: String(r.marktplatz ?? ""),
      marktplatz_name: marktplatzName(r.marktplatz),
      periode: alsPeriode(r.periode),
      von: String(r.zeitraum_von),
      bis: String(r.zeitraum_bis),
      zeilen: Number(r.zeilen ?? 0),
      aktualisiert: r.aktualisiert ?? null,
      lauf: status
        ? { status, meldung: r.meldung ?? null, gestartet: r.gestartet ?? null, beendet: r.beendet ?? null }
        : null,
    };
  });
}

/**
 * Ergebnis eines Abrufs festhalten. sync-sqp ruft das auf JEDEM Ausgang auf —
 * ein Abruf, der still verschwindet, lässt die Oberfläche ins Leere pollen.
 */
export async function merkeLauf(
  supabase: any,
  tenant_id: string,
  asin: string,
  periode: Periode,
  zeitraum: Zeitraum,
  ergebnis: { status: LaufStatus; zeilen?: number; meldung?: string; report_id?: string | null },
  marktplatz: string,
): Promise<void> {
  const { error } = await supabase.from("sqp_laeufe").upsert({
    tenant_id, marktplatz, asin, periode,
    zeitraum_von: zeitraum.von, zeitraum_bis: zeitraum.bis,
    status: ergebnis.status,
    zeilen: ergebnis.zeilen ?? null,
    meldung: ergebnis.meldung ?? null,
    report_id: ergebnis.report_id ?? null,
    beendet: ergebnis.status === "laeuft" ? null : new Date().toISOString(),
  }, { onConflict: "tenant_id,marktplatz,asin,periode,zeitraum_von" });
  // Bewusst nur geloggt: der Report selbst ist wichtiger als sein Statuseintrag.
  if (error) console.error("sqp_laeufe schreiben fehlgeschlagen:", error.message);
}

/**
 * Gespeicherte SQP-Zeilen einer ASIN für EINEN Zeitraum (Volumen absteigend).
 * Ohne `von` wird der zuletzt abgerufene Zeitraum dieser Periode gezeigt.
 */
export async function listeSqp(
  supabase: any,
  tenant_id: string,
  asin: string,
  periodeRoh?: unknown,
  vonRoh?: unknown,
  marktplatzRoh?: unknown,
): Promise<unknown> {
  const periode = alsPeriode(periodeRoh);
  // Wirft bei einer unbekannten Angabe, statt still auf Deutschland zu fallen:
  // ein Tippfehler im Land darf nicht als deutsche Zahlen zurueckkommen.
  const marktplatz = alsMarktplatz(marktplatzRoh);
  if (!asin) {
    return {
      rows: [], zeitraum: null, periode, lauf: null, vorhanden: [],
      marktplatz, marktplatz_name: marktplatz ? marktplatzName(marktplatz) : null,
    };
  }

  const vorhanden = await vorhandeneZeitraeume(supabase, tenant_id, asin, marktplatz);
  const gewuenscht = vonRoh ? zeitraumFuer(periode, String(vonRoh)) : null;
  const zuletzt = vorhanden.find((v) => v.periode === periode && v.zeilen > 0);
  const zeitraum: Zeitraum | null = gewuenscht ?? (zuletzt ? { von: zuletzt.von, bis: zuletzt.bis } : null);
  // Welcher Marktplatz gilt fuer die Abfrage unten? Der angeforderte, sonst der
  // des juengsten vorhandenen Zeitraums.
  const mpAktiv = marktplatz ?? zuletzt?.marktplatz ?? vorhanden[0]?.marktplatz ?? null;
  if (!zeitraum) {
    return {
      rows: [], zeitraum: null, periode, lauf: null, vorhanden,
      marktplatz: mpAktiv, marktplatz_name: mpAktiv ? marktplatzName(mpAktiv) : null,
    };
  }

  // Stand des gewählten Zeitraums — daran erkennt die Oberfläche sofort, ob noch
  // gewartet wird oder warum nichts kommt, statt blind weiterzupollen.
  const lauf = vorhanden.find((v) => v.periode === periode && v.von === zeitraum.von)?.lauf ?? null;

  let abfrage = supabase.from("sqp_rows")
    .select("search_query, volume, eigene_ctr, markt_ctr, ctr_index, eigene_cvr, markt_cvr, cvr_index, kaufanteil, duenn")
    .eq("tenant_id", tenant_id).eq("asin", asin).eq("periode", periode).eq("zeitraum_von", zeitraum.von);
  // Ohne Filter kaemen deutsche und franzoesische Suchbegriffe in einer Liste —
  // dieselbe ASIN, voellig verschiedene Maerkte.
  if (mpAktiv) abfrage = abfrage.eq("marktplatz", mpAktiv);
  const { data, error } = await abfrage.order("volume", { ascending: false });
  if (error) throw new Error(`sqp read: ${error.message}`);
  return {
    rows: data ?? [], zeitraum, periode, lauf, vorhanden,
    marktplatz: mpAktiv, marktplatz_name: mpAktiv ? marktplatzName(mpAktiv) : null,
  };
}

/** Verkaufte ASINs (für die Auswahl) + Flag, ob schon SQP-Daten vorliegen, + wählbare Zeiträume. */
export async function sqpAsins(supabase: any, tenant_id: string): Promise<unknown> {
  const [ordersRes, sqpRes, asinsRes] = await Promise.all([
    supabase.from("orders_history").select("asin, quantity").eq("tenant_id", tenant_id),
    supabase.from("sqp_rows").select("asin").eq("tenant_id", tenant_id),
    supabase.from("asins").select("asin, produktname").eq("tenant_id", tenant_id),
  ]);
  const units = new Map<string, number>();
  for (const o of ordersRes.data ?? []) if (o.asin) units.set(o.asin, (units.get(o.asin) ?? 0) + (Number(o.quantity) || 0));
  const mitDaten = new Set<string>((sqpRes.data ?? []).map((r: any) => String(r.asin)));
  const titel = new Map<string, string>((asinsRes.data ?? []).map((a: any) => [String(a.asin), String(a.produktname ?? a.asin)]));

  const asins = [...units.entries()].map(([asin, u]) => ({ asin, titel: titel.get(asin) ?? asin, units: u, hat_daten: mitDaten.has(asin) }));
  for (const a of mitDaten) if (!units.has(a)) asins.push({ asin: a, titel: titel.get(a) ?? a, units: 0, hat_daten: true });
  asins.sort((x, y) => (Number(y.hat_daten) - Number(x.hat_daten)) || (y.units - x.units));

  return {
    asins,
    zeitraeume: {
      WEEK: zeitraumListe("WEEK", WOCHEN_AUSWAHL),
      MONTH: zeitraumListe("MONTH", MONATE_AUSWAHL),
    },
  };
}

/**
 * SQP-Report für eine ASIN und einen Zeitraum asynchron anstoßen (läuft ~1–2 Min
 * im Hintergrund). Ohne `von` wird der letzte abgeschlossene Zeitraum geholt.
 */
export async function anstossenSqp(
  supabase: any,
  tenant_id: string,
  args: Record<string, unknown>,
): Promise<{
  ok: true; asin: string; periode: Periode; zeitraum: Zeitraum;
  marktplatz: string | null; marktplatz_name: string | null;
}> {
  const asin = String(args?.asin ?? "").trim();
  if (!asin) throw new Error("asin fehlt");
  const periode = alsPeriode(args?.periode);
  const zeitraum = args?.von ? zeitraumFuer(periode, String(args.von)) : letzterZeitraum(periode);
  const marktplatz = alsMarktplatz(args?.marktplatz);

  const { error } = await supabase.rpc("sqp_anstossen", {
    p_tenant: tenant_id, p_asin: asin, p_periode: periode,
    p_von: zeitraum.von, p_bis: zeitraum.bis, p_marktplatz: marktplatz,
  });
  if (error) throw new Error(`sqp_anstossen: ${error.message}`);
  return {
    ok: true, asin, periode, zeitraum,
    marktplatz, marktplatz_name: marktplatz ? marktplatzName(marktplatz) : null,
  };
}

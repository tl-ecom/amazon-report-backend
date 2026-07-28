// diagnostics.ts — Diagnosemodul (§7/§27): regelbasierte, deterministische Diagnosen.
//
// baueDiagnosen(...) ist REIN und unit-getestet: aus den vorhandenen Aggregatoren
// (Sales & Traffic, Listings) leitet sie strukturierte Diagnosen ab. Strikt getrennt:
//   beobachtung  = Fakt (was in den Daten steht)
//   begruendung  = warum es geprüft gehört (Regel-Logik, KEINE Ursachenbehauptung)
//   datenbasis   = Quelle + Zeitraum + Kennzahlen (Transparenz)
//   konfidenz    = wie belastbar (aus der Datenmenge), gering wird ehrlich benannt
//
// diagnosenLauf(...) gleicht die berechneten Diagnosen mit den gespeicherten ab:
// neue anlegen/aktualisieren, weggefallene auf "behoben". Nutzerentscheidungen
// (erledigt/verworfen) bleiben erhalten.

import { baueOverview } from "./metrics.ts";
import { baueListingsOverview } from "./listings.ts";

const SALES_TYPE = "GET_SALES_AND_TRAFFIC_REPORT";
const LISTINGS_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const SESSIONS_MIN = 30; // ab hier gilt Traffic als aussagekräftig
const SESSIONS_HOCH = 100; // ab hier hohe Konfidenz
const RETOUREN_SCHWELLE = 15; // % — auffällig hohe Retourenquote
const RETOUREN_UNITS_MIN = 20; // erst ab genug Verkäufen aussagekräftig

export type Konfidenz = "hoch" | "mittel" | "gering";
export type Prioritaet = "kritisch" | "hoch" | "mittel" | "niedrig";

export interface Diagnose {
  typ: string;
  asin: string | null;
  beobachtung: string;
  begruendung: string;
  datenbasis: Record<string, unknown>;
  konfidenz: Konfidenz;
  prioritaet: Prioritaet;
}

const PRIO_RANG: Record<Prioritaet, number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 };

/** Stabiler Schlüssel für idempotente Läufe: eine Diagnose pro Typ+ASIN. */
export function fingerprintOf(d: Pick<Diagnose, "typ" | "asin">): string {
  return `${d.typ}:${d.asin ?? "-"}`;
}

/** Leitet aus Sales-Overview + Listings-Overview deterministische Diagnosen ab. */
export function baueDiagnosen(sales: any, listings: any): Diagnose[] {
  const out: Diagnose[] = [];
  const zeitraum = sales?.zeitraum ?? null;
  const accCvr: number | null = sales?.gesamt?.cvrUnitSession ?? null;
  const proAsin: any[] = sales?.proAsin ?? [];

  // Umsatzkonzentration (Konto): eine ASIN trägt > 50 % des Umsatzes.
  const top = proAsin[0];
  if (top && top.umsatzAnteil != null && top.umsatzAnteil > 50) {
    out.push({
      typ: "umsatzkonzentration",
      asin: top.childAsin ?? null,
      beobachtung: `${top.childAsin} macht ${top.umsatzAnteil} % des Umsatzes aus.`,
      begruendung: "Hohe Abhängigkeit von einer einzigen ASIN ist ein Klumpenrisiko — fällt sie aus (Sperre, Out-of-Stock, Ranking), trifft es den ganzen Account.",
      datenbasis: { quelle: "Sales & Traffic", zeitraum, umsatzanteil_prozent: top.umsatzAnteil },
      konfidenz: "mittel",
      prioritaet: "mittel",
    });
  }

  for (const a of proAsin) {
    const sessions = Number(a.sessions) || 0;
    const units = Number(a.unitsOrdered) || 0;
    const cvr = a.cvrUnitSession;
    const asin = a.childAsin ?? null;

    if (sessions >= SESSIONS_MIN && units === 0) {
      out.push({
        typ: "traffic_ohne_verkauf",
        asin,
        beobachtung: `${sessions} Sessions, aber 0 verkaufte Einheiten im Zeitraum.`,
        begruendung: "Es kommt Traffic an, der nicht konvertiert. Zu prüfen sind Preis, Buy-Box/Verfügbarkeit, Bilder/Content und Bewertungen — die Daten sagen nicht, welche Ursache es ist.",
        datenbasis: { quelle: "Sales & Traffic", zeitraum, sessions, units },
        konfidenz: sessions >= SESSIONS_HOCH ? "hoch" : "mittel",
        prioritaet: "hoch",
      });
    } else if (accCvr && sessions >= SESSIONS_MIN && cvr != null && cvr < accCvr * 0.5) {
      out.push({
        typ: "conversion_unter_schnitt",
        asin,
        beobachtung: `CVR ${cvr} % — weniger als die Hälfte des Account-Schnitts (${accCvr} %).`,
        begruendung: "Diese ASIN konvertiert deutlich schlechter als der Rest des Accounts. Ein Vergleich der Detailseite mit den stärkeren ASINs lohnt sich.",
        datenbasis: { quelle: "Sales & Traffic", zeitraum, sessions, cvr_prozent: cvr, account_cvr_prozent: accCvr },
        konfidenz: sessions >= SESSIONS_HOCH ? "hoch" : "mittel",
        prioritaet: "mittel",
      });
    }

    if (accCvr && cvr != null && cvr > accCvr && sessions > 0 && sessions < SESSIONS_MIN) {
      out.push({
        typ: "gute_cvr_wenig_traffic",
        asin,
        beobachtung: `Gute CVR (${cvr} %) bei nur ${sessions} Sessions.`,
        begruendung: "Das Angebot konvertiert überdurchschnittlich, bekommt aber wenig Reichweite. Mehr Traffic (PPC, Ranking) könnte überproportional wirken.",
        datenbasis: { quelle: "Sales & Traffic", zeitraum, sessions, cvr_prozent: cvr, account_cvr_prozent: accCvr },
        konfidenz: "gering",
        prioritaet: "niedrig",
      });
    }
  }

  // Auffällig hohe Retourenquote (Konto) — nur bei genug Verkäufen aussagekräftig.
  const rq: number | null = sales?.gesamt?.retourenquote ?? null;
  const accUnits = Number(sales?.gesamt?.unitsOrdered) || 0;
  if (rq != null && rq > RETOUREN_SCHWELLE && accUnits >= RETOUREN_UNITS_MIN) {
    out.push({
      typ: "hohe_retourenquote",
      asin: null,
      beobachtung: `Retourenquote ${rq} % über ${accUnits} verkaufte Einheiten.`,
      begruendung: "Eine hohe Retourenquote deutet auf eine Lücke zwischen Erwartung und Produkt hin (Beschreibung, Größe/Passform, Qualität). Retouren- und Verkaufszeitraum können sich unterscheiden.",
      datenbasis: { quelle: "Sales & Traffic", zeitraum, retourenquote_prozent: rq, units: accUnits },
      konfidenz: accUnits >= 50 ? "hoch" : "mittel",
      prioritaet: "hoch",
    });
  }

  // Aktive Merchant-Angebote ohne Bestand (Konto): live, aber nicht verkaufsfähig.
  const ausverkauft = Number(listings?.bestand_merchant?.ausverkauft) || 0;
  if (ausverkauft > 0) {
    out.push({
      typ: "fbm_ohne_bestand",
      asin: null,
      beobachtung: `${ausverkauft} aktive Merchant-Angebote mit Bestand 0.`,
      begruendung: "Diese Angebote sind live, aber nicht kaufbar — sie verbrennen Ranking und Sichtbarkeit, ohne verkaufen zu können. Bestand auffüllen oder deaktivieren.",
      datenbasis: { quelle: "Listings", stichtag: listings?.data_timestamp ?? null, ausverkauft },
      konfidenz: "hoch",
      prioritaet: "kritisch",
    });
  }

  return out.sort((a, b) => PRIO_RANG[a.prioritaet] - PRIO_RANG[b.prioritaet]);
}

async function ladeLatest(supabase: any, tenant_id: string, reportType: string): Promise<any | null> {
  const { data } = await supabase
    .from("report_data")
    .select("payload, data_timestamp, is_provisional")
    .eq("tenant_id", tenant_id).eq("source", "sp").eq("report_type", reportType).eq("is_latest", true)
    .maybeSingle();
  return data ?? null;
}

/**
 * Ein Diagnose-Lauf: berechnet die aktuellen Diagnosen und gleicht sie mit den
 * gespeicherten ab (idempotent über fingerprint).
 *  - neu/weiterhin gültig → anlegen bzw. Inhalt aktualisieren (Status bleibt)
 *  - vorher "behoben", jetzt wieder auffällig → zurück auf "offen"
 *  - vorher "offen", jetzt nicht mehr auffällig → "behoben"
 *  - "erledigt"/"verworfen" (Nutzerentscheidung) bleiben unangetastet
 */
export async function diagnosenLauf(supabase: any, tenant_id: string): Promise<{ anzahl: number; offen: number }> {
  const [salesRow, listingsRow] = await Promise.all([
    ladeLatest(supabase, tenant_id, SALES_TYPE),
    ladeLatest(supabase, tenant_id, LISTINGS_TYPE),
  ]);
  const sales = salesRow ? baueOverview(salesRow.payload, salesRow.data_timestamp, salesRow.is_provisional) as any : null;
  const listings = listingsRow ? baueListingsOverview(listingsRow.payload, listingsRow.data_timestamp) as any : null;

  const computed = baueDiagnosen(sales, listings);
  const fps = computed.map((d) => fingerprintOf(d));
  const now = new Date().toISOString();

  // Anlegen / Inhalt aktualisieren. Status wird NICHT mitgeschickt -> bleibt bei
  // Konflikt unverändert, bei Insert greift der Default 'offen'.
  if (computed.length > 0) {
    const rows = computed.map((d) => ({
      tenant_id, asin: d.asin, typ: d.typ, beobachtung: d.beobachtung, begruendung: d.begruendung,
      datenbasis: d.datenbasis, konfidenz: d.konfidenz, prioritaet: d.prioritaet,
      fingerprint: fingerprintOf(d), updated_at: now,
    }));
    const { error } = await supabase.from("diagnoses").upsert(rows, { onConflict: "tenant_id,fingerprint" });
    if (error) throw new Error(`diagnoses upsert: ${error.message}`);

    // Wieder aufgetreten: behoben -> offen.
    await supabase.from("diagnoses").update({ status: "offen", updated_at: now })
      .eq("tenant_id", tenant_id).eq("status", "behoben").in("fingerprint", fps);
  }

  // Weggefallen: offene Diagnosen, die nicht mehr berechnet werden -> behoben.
  let weg = supabase.from("diagnoses").update({ status: "behoben", updated_at: now })
    .eq("tenant_id", tenant_id).eq("status", "offen");
  if (fps.length > 0) {
    weg = weg.not("fingerprint", "in", `(${fps.map((f) => `"${f}"`).join(",")})`);
  }
  const { error: wegErr } = await weg;
  if (wegErr) throw new Error(`diagnoses auto-resolve: ${wegErr.message}`);

  const offen = computed.length; // frisch berechnete gelten als offen/aktiv
  return { anzahl: computed.length, offen };
}

/** Gespeicherte Diagnosen lesen (offene zuerst, dann nach Priorität). */
export async function listeDiagnosen(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("diagnoses")
    .select("id, asin, typ, beobachtung, begruendung, datenbasis, konfidenz, prioritaet, status, created_at, updated_at")
    .eq("tenant_id", tenant_id);
  if (error) throw new Error(`diagnoses read: ${error.message}`);

  const STATUS_RANG: Record<string, number> = { offen: 0, behoben: 1, erledigt: 2, verworfen: 3 };
  const rows = (data ?? []).slice().sort((a: any, b: any) => {
    const s = (STATUS_RANG[a.status] ?? 9) - (STATUS_RANG[b.status] ?? 9);
    if (s !== 0) return s;
    return (PRIO_RANG[a.prioritaet as Prioritaet] ?? 9) - (PRIO_RANG[b.prioritaet as Prioritaet] ?? 9);
  });
  const offen = rows.filter((r: any) => r.status === "offen").length;
  return { diagnosen: rows, offen };
}

const ERLAUBTE_STATUS = new Set(["offen", "erledigt", "verworfen"]);

/** Status einer Diagnose setzen (Nutzeraktion). Tenant-gescoped. */
export async function setzeDiagnoseStatus(
  supabase: any, tenant_id: string, id: string, status: string,
): Promise<{ ok: true }> {
  if (!ERLAUBTE_STATUS.has(status)) throw new Error(`ungültiger Status: ${status}`);
  const { error } = await supabase.from("diagnoses")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`diagnose status: ${error.message}`);
  return { ok: true };
}

// ads_negativ_wirkung.ts — was hat ein angelegtes Negative abgeschnitten.
//
// Ein Negative ist die einzige Ads-Änderung, deren Wirkung man nicht NACH,
// sondern VOR der Änderung abliest: was der Begriff in seinem Geltungsbereich
// davor gebracht hat, ist genau das, was seither fehlt. Waren es nur Kosten,
// hat das Negative gespart. Hingen Bestellungen daran, hat es sie abgeschnitten
// — es sei denn, sie tauchen anderswo wieder auf.
//
// Deshalb drei Zahlen je Negative:
//   vorher             der Begriff im Geltungsbereich davor   → was wegfällt
//   nachher            derselbe danach                        → müsste null sein
//   anderswo vor/nach  derselbe Begriff in anderen Gruppen    → kam es dort an?
//
// Vanejas Fall vom 09.09.2026: "kratzbretter katze" als Exact-Negativ in der
// Exact-Kampagne, Begründung "Misrouting zur Single-Keyword-Kampagne". Davor
// 142 Klicks und 25 Bestellungen im Geltungsbereich, danach null. Anderswo 13 →
// 17 Bestellungen. Geroutet werden sollten 25, angekommen sind 4.
//
// Wie überall: nebeneinander, kein Beweis. Saison und Wettbewerb laufen mit.

import { type Fenster, fenster } from "./ads_changelog.ts";
import { ladeSteuerung } from "./ads_steuerung.ts";
import { marktplatzKopf } from "./ads_marktplatz.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Unter einer Woche Daten ist jede Aussage zu früh. */
export const MIN_TAGE = 7;

interface Summen { clicks: number; spend_cents: number; sales_cents: number; orders: number }

export interface NegativZeile {
  begriff: string; typ: "keyword" | "asin"; match: "exact" | "phrase"; ebene: "gruppe" | "kampagne";
  campaign_id: string; campaign_name: string | null; ad_group_name: string | null;
  am: string; quelle: "pulse_log" | "snapshot"; grund: string | null; tage: number;
  vorher: Summen; nachher: Summen;
  anderswo_vorher: Summen | null; anderswo_nachher: Summen | null;
}

export type Einordnung =
  | "zu_frueh"                    // weniger als eine Woche Daten seit der Anlage
  | "vorsorglich"                 // der Begriff hatte im Geltungsbereich davor keinen Klick
  | "kosten_gespart"              // davor Klicks, aber keine Bestellung
  | "bestellungen_verlagert"      // davor Bestellungen, anderswo sind mindestens so viele dazugekommen
  | "bestellungen_abgeschnitten"; // davor Bestellungen, anderswo kam weniger an als wegfiel

function f(s: Summen): Fenster {
  return fenster(Number(s.clicks) || 0, Number(s.spend_cents) || 0, Number(s.sales_cents) || 0, Number(s.orders) || 0);
}

export function baueNegativWirkung(z: NegativZeile) {
  const tage = Number(z.tage) || 0;
  const vorher = f(z.vorher);
  const nachher = f(z.nachher);
  const aVor = z.anderswo_vorher ? f(z.anderswo_vorher) : null;
  const aNach = z.anderswo_nachher ? f(z.anderswo_nachher) : null;

  // Was anderswo dazukam. null bei Phrase-Negatives: dort ist "derselbe
  // Begriff" nicht eindeutig.
  const anderswoBestellungen = aVor && aNach ? aNach.bestellungen - aVor.bestellungen : null;
  // Netto über alles: weggefallen im Geltungsbereich, dazugekommen anderswo.
  const netto = anderswoBestellungen === null ? null
    : (nachher.bestellungen - vorher.bestellungen) + anderswoBestellungen;

  let einordnung: Einordnung;
  if (tage < MIN_TAGE) einordnung = "zu_frueh";
  else if (vorher.klicks === 0) einordnung = "vorsorglich";
  else if (vorher.bestellungen === 0) einordnung = "kosten_gespart";
  else if (netto !== null && netto >= 0) einordnung = "bestellungen_verlagert";
  else einordnung = "bestellungen_abgeschnitten";

  return {
    begriff: z.begriff,
    typ: z.typ,
    match: z.match,
    ebene: z.ebene,
    kampagne: z.campaign_name,
    anzeigengruppe: z.ad_group_name,
    am: z.am,
    quelle: z.quelle,
    begruendung: z.grund,
    tage,
    einordnung,
    // Das, was seither fehlt.
    vorher,
    nachher,
    // Greift das Negative? Klicks im Geltungsbereich NACH der Anlage dürfte es nicht geben.
    greift_nicht: tage >= MIN_TAGE && nachher.klicks > 0,
    anderswo_vorher: aVor,
    anderswo_nachher: aNach,
    anderswo_bestellungen_differenz: anderswoBestellungen,
    // Im Geltungsbereich weggefallen plus anderswo dazugekommen. Negativ = unterm Strich verloren.
    bestellungen_netto: tage >= MIN_TAGE ? netto : null,
    // Was der Begriff im gleich langen Fenster davor gekostet hat — so viel
    // hätte er etwa wieder gekostet.
    kosten_gespart: tage >= MIN_TAGE ? r2(vorher.kosten - nachher.kosten) : null,
  };
}

function tag(x: unknown): string | null {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
}

export async function adsNegativWirkung(
  supabase: any, tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const von = tag(opts?.von) ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const bis = tag(opts?.bis) ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("ads_negativ_wirkung", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_von: von, p_bis: bis,
  });
  if (error) throw new Error("ads_negativ_wirkung: " + error.message);

  const modusVon = await ladeSteuerung(supabase, tenant_id);
  const negatives = ((data?.zeilen ?? []) as NegativZeile[])
    .map((z) => ({ ...baueNegativWirkung(z), steuerung: modusVon(z.campaign_id) }));
  const von_art = (e: Einordnung) => negatives.filter((n) => n.einordnung === e);
  const gespart = von_art("kosten_gespart");
  const abgeschnitten = von_art("bestellungen_abgeschnitten");

  return {
    ...kopf,
    zeitraum: { von, bis },
    daten_bis: data?.letzter_tag ?? null,
    anzahl: negatives.length,
    bilanz: {
      zu_frueh: von_art("zu_frueh").length,
      vorsorglich: von_art("vorsorglich").length,
      kosten_gespart: { anzahl: gespart.length, euro: r2(gespart.reduce((n, x) => n + (x.kosten_gespart ?? 0), 0)) },
      bestellungen_verlagert: von_art("bestellungen_verlagert").length,
      bestellungen_abgeschnitten: {
        anzahl: abgeschnitten.length,
        // Unterm Strich verloren, über alle abgeschnittenen Negatives.
        bestellungen_netto: abgeschnitten.reduce((n, x) => n + (x.bestellungen_netto ?? (x.nachher.bestellungen - x.vorher.bestellungen)), 0),
      },
      greift_nicht: negatives.filter((n) => n.greift_nicht).length,
    },
    // Das Wichtige zuerst: abgeschnittene Bestellungen, dann die größte Ersparnis.
    negatives: negatives.sort((a, b) =>
      (b.vorher.bestellungen - a.vorher.bestellungen) || (b.vorher.kosten - a.vorher.kosten)
    ),
    hinweise: [
      "`vorher` ist der Suchbegriff im Geltungsbereich des Negativs (Anzeigengruppe oder Kampagne) im "
      + "gleich langen Fenster vor der Anlage — genau das, was seither wegfällt. Höchstens 30 Tage.",
      "`bestellungen_abgeschnitten`: davor hingen Bestellungen am Begriff, und anderswo kam weniger an, "
      + "als wegfiel. `bestellungen_verlagert`: anderswo kamen mindestens so viele dazu. Nebeneinander, "
      + "kein Beweis — Saison und Wettbewerb laufen mit.",
      "`greift_nicht`: im Geltungsbereich gab es nach der Anlage noch Klicks auf den Begriff. Dann "
      + "wurde das Negative entfernt, liegt an einer anderen Stelle als gedacht, oder Amazon wertet "
      + "eine enge Variante anders.",
      "Bei Phrase-Negatives fehlt `anderswo`: sie treffen viele Suchbegriffe, nicht einen. Sind dort "
      + "Bestellungen weggefallen, gelten sie deshalb als abgeschnitten.",
      `Ads-Daten bis ${data?.letzter_tag ?? "—"}. Quelle \`pulse_log\`: über Pulse angelegt, mit `
      + "Begründung. `snapshot`: im Struktur-Snapshot erkannt, erst seit dem 04.10.2026.",
      "Nur Sponsored Products.",
    ],
  };
}

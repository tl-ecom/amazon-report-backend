// ads_produkt_verlauf.ts — Tagesverlauf je verwaltetem Produkt.
//
// Die Lage je Produkt (ads_produkt_lage.ts) stellt zwei Fenster nebeneinander.
// Fällt dort der Gesamtumsatz, sagt sie nicht, WANN. Hier steht jeder Tag:
// Werbekosten, Werbeumsatz, Umsatz aus allen Bestellungen — und die Summe der
// jeweils letzten 7 Tage, weil einzelne Tage bei kleinen Produkten springen.

import { marktplatzKopf } from "./ads_marktplatz.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

export interface VerlaufZeile {
  produkt: string; datum: string;
  spend_cents: number | string; sales_cents: number | string; orders: number | string; clicks: number | string;
  umsatz_cents: number | string; einheiten: number | string;
}

/**
 * `ohne_werbung` = Gesamtumsatz minus Werbeumsatz. Das ist eine Rechnung, keine
 * Messung: Amazon schreibt Werbeumsatz dem Tag des KLICKS zu, die Bestellung
 * zählt am Tag des Kaufs. An einzelnen Tagen kann die Zahl deshalb negativ sein;
 * über 7 Tage gleicht sich das weitgehend aus.
 *
 * `woche` summiert den Tag und die sechs davor; null, solange noch keine sieben
 * Tage im Verlauf liegen.
 */
export function baueVerlauf(zeilen: VerlaufZeile[]) {
  const je = new Map<string, VerlaufZeile[]>();
  for (const z of zeilen) {
    const liste = je.get(z.produkt) ?? [];
    liste.push(z);
    je.set(z.produkt, liste);
  }
  return [...je.entries()].map(([produkt, liste]) => {
    const tage = liste.sort((a, b) => a.datum.localeCompare(b.datum)).map((z) => ({
      datum: z.datum,
      werbekosten: r2(Number(z.spend_cents) / 100),
      werbeumsatz: r2(Number(z.sales_cents) / 100),
      gesamtumsatz: r2(Number(z.umsatz_cents) / 100),
      einheiten: Number(z.einheiten),
    }));
    return {
      produkt,
      tage: tage.map((t, i) => {
        const f = i >= 6 ? tage.slice(i - 6, i + 1) : null;
        const s = (k: "werbekosten" | "werbeumsatz" | "gesamtumsatz") => r2(f!.reduce((n, x) => n + x[k], 0));
        return {
          ...t,
          ohne_werbung: r2(t.gesamtumsatz - t.werbeumsatz),
          woche: f === null ? null : {
            werbekosten: s("werbekosten"), werbeumsatz: s("werbeumsatz"), gesamtumsatz: s("gesamtumsatz"),
            ohne_werbung: r2(s("gesamtumsatz") - s("werbeumsatz")),
            tacos: s("gesamtumsatz") > 0 ? Math.round((s("werbekosten") / s("gesamtumsatz")) * 10000) / 10000 : null,
          },
        };
      }),
    };
  }).sort((a, b) => a.produkt.localeCompare(b.produkt));
}

export interface Ereignis {
  produkt: string; datum: string;
  art: "preis" | "listing_aus" | "listing_an" | "angebot" | "ohne_bestand" | "werbung";
  text: string; anzahl: number;
}

/** Ereignisse an ihre Produkte hängen. "42 Negatives angelegt" statt 42 Zeilen kommt schon so aus SQL. */
export function mitEreignissen<T extends { produkt: string }>(produkte: T[], ereignisse: Ereignis[]) {
  return produkte.map((p) => ({
    ...p,
    ereignisse: ereignisse
      .filter((e) => e.produkt === p.produkt)
      .map((e) => ({
        datum: e.datum, art: e.art,
        // Der Listing-Status gilt je SKU. "Listing inaktiv" klänge, als wäre das Produkt weg.
        text: (Number(e.anzahl) > 1 ? `${e.anzahl} ${e.text}` : e.text).replace(/^Listing /, "Ein Angebot "),
      }))
      .sort((a, b) => a.datum.localeCompare(b.datum)),
  }));
}

export async function adsProduktVerlauf(
  supabase: any, tenant_id: string, opts?: { tage?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const tage = Math.max(7, Math.min(Number(opts?.tage) || 42, 180));
  const { data, error } = await supabase.rpc("ads_produkt_verlauf", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_tage: tage,
  });
  if (error) throw new Error("ads_produkt_verlauf: " + error.message);
  const er = await supabase.rpc("ads_produkt_ereignisse", { p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_tage: tage });
  if (er.error) throw new Error("ads_produkt_ereignisse: " + er.error.message);
  const ohneAsin = (data?.produkte_ohne_asin ?? []) as string[];
  return {
    ...kopf,
    tage,
    daten_bis: data?.letzter_tag ?? null,
    produkte: mitEreignissen(baueVerlauf((data?.zeilen ?? []) as VerlaufZeile[]), (er.data ?? []) as Ereignis[]),
    hinweise: [
      "`ereignisse` je Produkt: Preiswechsel und Listing-Status (aus dem täglichen Listing-Abgleich, auf einen "
      + "Tag genau), Tage ohne verkaufsfähigen FBA-Bestand, und was über Pulse am Werbekonto geändert wurde. "
      + "NICHT enthalten: Änderungen der Helium-10-KI und alles, was direkt in Seller Central am Werbekonto "
      + "geändert wurde, außerdem Coupons, Angebote und Wettbewerber. Ein Ereignis am selben Tag wie ein Knick "
      + "ist ein Hinweis, keine Ursache.",
      "„Ein Angebot inaktiv“ gilt je SKU: hat eine ASIN mehrere Angebote (FBA und Eigenversand), kann das "
      + "Produkt trotzdem verkäuflich gewesen sein. Ob es das war, zeigt der Gesamtumsatz der Tage danach.",
      "`ohne_werbung` ist gerechnet (Gesamtumsatz minus Werbeumsatz), nicht gemessen: Amazon bucht Werbeumsatz "
      + "auf den Tag des Klicks, die Bestellung zählt am Kauftag. Einzelne Tage können negativ sein — "
      + "belastbar ist `woche` (der Tag und die sechs davor).",
      `Ads-Daten bis ${data?.letzter_tag ?? "—"}; die jüngsten drei Tage davon passt Amazon noch an.`,
      "Gesamtumsatz: alle Bestellungen der ASINs, die die Kampagnen des Produkts in den letzten 90 Tagen "
      + "beworben haben, ohne stornierte.",
      ...(ohneAsin.length ? ["Ohne ASIN-Zuordnung, deshalb Gesamtumsatz 0: " + ohneAsin.join(", ") + "."] : []),
    ],
  };
}

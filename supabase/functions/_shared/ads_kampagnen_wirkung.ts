// ads_kampagnen_wirkung.ts — was kam nach einer Budget- oder Platzierungsänderung.
//
// Der Ads-Changelog bewertet Gebote je Ziel. Budget und Platzierungs-Aufschlag
// hängen an der Kampagne und fehlten dort. Die Rohlage kommt aus der
// SQL-Funktion ads_kampagnen_wirkung; hier wird eingeordnet.
//
// ZWEI EBENEN bei Platzierungen: die ganze Kampagne und die eine Platzierung,
// deren Aufschlag geändert wurde. Das Urteil steht bei Platzierungen auf der
// PLATZIERUNG — dort soll die Änderung wirken. Die Kampagne steht daneben, weil
// ein Aufschlag auf Top of Search Budget von den anderen Platzierungen abzieht.
//
// Vanejas Beispiel vom 09.09.2026: Top of Search von 20 auf 50 %. An der
// Platzierung 3 → 135 Klicks und 0 → 5 Bestellungen; in der ganzen Kampagne
// 4 → 22 Bestellungen, aber die Kosten von 29 € auf 338 €. Beides ist wahr, und
// erst zusammen ergibt es ein Bild.
//
// Wie überall: sieben Tage davor gegen sieben Tage danach, nebeneinander, kein
// Beweis. Der Änderungstag selbst ist ausgenommen — er ist halb alt, halb neu.

import { type Fenster, fenster, type Urteil, urteilAus } from "./ads_changelog.ts";
import { marktplatzKopf } from "./ads_marktplatz.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Wie im Changelog: unter fünf Klicks ist der ACoS Zufall, kein Messwert. */
export const MIN_KLICKS = 5;

interface Summen { clicks: number; spend_cents: number; sales_cents: number; orders: number }

export interface WirkungZeile {
  campaign_id: string; campaign_name: string | null;
  feld: "budget" | "mod_top" | "mod_produktseite" | "mod_rest";
  platzierung: string | null;
  vorher: number | string; nachher: number | string;
  am: string; fenster_ab: string | null; quelle: "pulse_log" | "snapshot"; grund: string | null;
  nachlauf_vollstaendig: boolean;
  davor: Summen; danach: Summen;
  platz_davor: Summen | null; platz_danach: Summen | null;
}

function f(s: Summen): Fenster {
  return fenster(Number(s.clicks) || 0, Number(s.spend_cents) || 0, Number(s.sales_cents) || 0, Number(s.orders) || 0);
}

export function baueKampagnenWirkung(z: WirkungZeile) {
  const vorher = Number(z.vorher);
  const nachher = Number(z.nachher);
  const davor = f(z.davor);
  const danach = f(z.danach);
  const platzDavor = z.platz_davor ? f(z.platz_davor) : null;
  const platzDanach = z.platz_danach ? f(z.platz_danach) : null;
  const istPlatzierung = z.feld !== "budget";

  // Worauf das Urteil steht: bei Platzierungen auf der Platzierung selbst.
  const massDavor = istPlatzierung && platzDavor ? platzDavor : davor;
  const massDanach = istPlatzierung && platzDanach ? platzDanach : danach;

  let grund: string | null = null;
  if (!z.nachlauf_vollstaendig) {
    grund = "Die sieben Tage nach der Änderung sind noch nicht vollständig.";
  } else if (massDavor.klicks < MIN_KLICKS || massDanach.klicks < MIN_KLICKS) {
    grund = `Zu wenig Traffic für einen Vergleich: ${massDavor.klicks} Klicks davor, ${massDanach.klicks} danach`
      + (istPlatzierung ? " an dieser Platzierung" : "") + ` (nötig sind ${MIN_KLICKS} in beiden Fenstern).`;
  }
  const vergleichbar = grund === null;
  const urteil: Urteil | null = vergleichbar ? urteilAus(massDavor, massDanach) : null;

  return {
    am: z.am,
    // Bei Snapshot-Änderungen liegt der Zeitpunkt zwischen fenster_ab und am.
    fenster_ab: z.fenster_ab,
    quelle: z.quelle,
    kampagne: z.campaign_name,
    campaignId: z.campaign_id,
    feld: z.feld,
    vorher: r2(vorher),
    nachher: r2(nachher),
    richtung: nachher > vorher ? "hoch" : "runter",
    begruendung: z.grund,
    kampagne_davor: davor,
    kampagne_danach: danach,
    platzierung_davor: platzDavor,
    platzierung_danach: platzDanach,
    vergleichbar,
    grund,
    // Bei Budget an der Kampagne gemessen, bei Platzierungen an der Platzierung.
    urteil,
    urteil_ebene: istPlatzierung ? "platzierung" : "kampagne",
    umsatz_differenz: vergleichbar ? r2(massDanach.umsatz - massDavor.umsatz) : null,
    kosten_differenz: vergleichbar ? r2(massDanach.kosten - massDavor.kosten) : null,
    // Die ganze Kampagne, unabhängig vom Urteil — bei Platzierungen der zweite Blick.
    kampagne_umsatz_differenz: z.nachlauf_vollstaendig ? r2(danach.umsatz - davor.umsatz) : null,
    kampagne_kosten_differenz: z.nachlauf_vollstaendig ? r2(danach.kosten - davor.kosten) : null,
  };
}

function tag(x: unknown): string | null {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
}

export async function adsKampagnenWirkung(
  supabase: any, tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const von = tag(opts?.von) ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const bis = tag(opts?.bis) ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("ads_kampagnen_wirkung", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_von: von, p_bis: bis,
  });
  if (error) throw new Error("ads_kampagnen_wirkung: " + error.message);

  const aenderungen = ((data?.zeilen ?? []) as WirkungZeile[]).map(baueKampagnenWirkung);
  const vergleichbar = aenderungen.filter((a) => a.vergleichbar);
  const zaehle = (art: "budget" | "platzierung") =>
    vergleichbar.filter((a) => (a.feld === "budget") === (art === "budget")).reduce(
      (acc, a) => { acc[a.urteil ?? "unveraendert"] = (acc[a.urteil ?? "unveraendert"] ?? 0) + 1; return acc; },
      {} as Record<string, number>,
    );

  return {
    ...kopf,
    zeitraum: { von, bis },
    daten_bis: data?.letzter_tag ?? null,
    anzahl: aenderungen.length,
    davon_vergleichbar: vergleichbar.length,
    bilanz: { budget: zaehle("budget"), platzierung: zaehle("platzierung") },
    aenderungen,
    hinweise: [
      "Sieben Tage davor gegen sieben Tage danach, ohne den Änderungstag. Nebeneinander, kein Beweis: "
      + "in denselben Tagen ändern sich Saison, Wettbewerb und Bestand mit.",
      "Bei Platzierungen steht das Urteil auf der geänderten Platzierung (`urteil_ebene`). Die ganze "
      + "Kampagne steht daneben (`kampagne_*`): ein Aufschlag verschiebt Budget zwischen den Platzierungen.",
      "Quelle `pulse_log`: über Pulse geändert, minutengenau, mit Begründung. `snapshot`: im täglichen "
      + "Struktur-Snapshot erkannt (auch Änderungen in der Amazon-Konsole), erst seit dem 04.10.2026 und "
      + "nur auf das Fenster zwischen zwei Snapshots genau.",
      `Ads-Daten liegen bis ${data?.letzter_tag ?? "—"} vor.`,
      "Nur Sponsored Products.",
    ],
  };
}

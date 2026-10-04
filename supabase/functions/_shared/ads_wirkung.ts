// ads_wirkung.ts — was haben neu angelegte Keywords und Targets gebracht.
//
// Das letzte Glied der Kette Kandidat → anlegen → messen. Die Rohlage kommt aus
// der SQL-Funktion ads_keyword_wirkung; hier wird eingeordnet — rein und testbar.
//
// DREI FENSTER GLEICHER LÄNGE:
//   eigen     das neue Ziel selbst seit dem Anlegen
//   vorher    derselbe Suchbegriff über ANDERE Ziele davor
//   anderswo  derselbe Suchbegriff über andere Ziele seither
//
// Die ehrliche Frage ist nicht "was hat das neue Keyword verdient", sondern
// "was ist mit dem Suchbegriff INSGESAMT passiert". Ein Exact-Keyword, das die
// Bestellungen nur aus der Broad-Kampagne herüberzieht, hat nichts gewonnen.
// Deshalb wird `gesamt_danach` (eigen + anderswo) gegen `vorher` gehalten.
//
// Und wie überall: nebeneinander, kein Beweis. In denselben Wochen ändern sich
// Saison, Wettbewerb und Bestand mit.
//
// BEWUSST OHNE URTEIL. Das Urteil aus dem Changelog (Umsatz und ROAS danach
// gegen davor) führt hier in die Irre: Vanejas "obstschale" brachte eine
// Bestellung für 92 € Werbekosten — 274 % ACoS. Weil der Begriff davor gar
// keinen Umsatz hatte, wäre das rechnerisch "beides besser". Für ein neues
// Ziel zählt der eigene ACoS und was der Begriff insgesamt mehr kostet; beides
// steht als Zahl da.

import { type Fenster, fenster } from "./ads_changelog.ts";
import { marktplatzKopf } from "./ads_marktplatz.ts";

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Unter einer Woche Daten ist jede Aussage zu früh. */
export const MIN_TAGE = 7;
/** Wie im Changelog: unter fünf Klicks ist der ACoS Zufall, kein Messwert. */
export const MIN_KLICKS = 5;

interface Summen { clicks: number; spend_cents: number; sales_cents: number; orders: number }

export interface WirkungZeile {
  ziel_id: string; art: "keyword" | "target"; text: string | null; match_type: string | null;
  state: string | null; gebot_cents: number | null;
  campaign_id: string | null; campaign_name: string | null;
  angelegt: string; quelle: "pulse_log" | "snapshot"; tage: number; begriff: string | null;
  eigen: Summen; vorher: Summen | null; anderswo: Summen | null;
}

export type Status = "zu_frueh" | "kein_traffic" | "wenig_traffic" | "auswertbar";

function f(s: Summen): Fenster {
  return fenster(Number(s.clicks) || 0, Number(s.spend_cents) || 0, Number(s.sales_cents) || 0, Number(s.orders) || 0);
}

function summe(a: Summen, b: Summen): Summen {
  return {
    clicks: Number(a.clicks) + Number(b.clicks), spend_cents: Number(a.spend_cents) + Number(b.spend_cents),
    sales_cents: Number(a.sales_cents) + Number(b.sales_cents), orders: Number(a.orders) + Number(b.orders),
  };
}

export function statusAus(tage: number, klicks: number): Status {
  if (tage < MIN_TAGE) return "zu_frueh";
  if (klicks === 0) return "kein_traffic";
  if (klicks < MIN_KLICKS) return "wenig_traffic";
  return "auswertbar";
}

export function baueWirkung(z: WirkungZeile) {
  const eigen = f(z.eigen);
  const tage = Number(z.tage) || 0;
  const status = statusAus(tage, eigen.klicks);
  const vorher = z.vorher ? f(z.vorher) : null;
  const anderswo = z.anderswo ? f(z.anderswo) : null;
  const gesamt = z.anderswo ? f(summe(z.eigen, z.anderswo)) : null;

  // Vergleich, sobald der Begriff eindeutig ist, eine Woche Daten vorliegt und
  // es DAVOR nennenswerten Traffic auf dem Begriff gab. Bewusst unabhängig
  // davon, ob das neue Ziel selbst Klicks hat: Vanejas "kratzbrett l form"
  // brachte über andere Ziele 4 Bestellungen in sieben Tagen; nach dem Anlegen
  // des Exact-Keywords kamen 2 Klicks und keine Bestellung mehr. Genau dieser
  // Fall — der Begriff ist beim Umzug verloren gegangen — wäre unsichtbar,
  // wenn "wenig Traffic" den Vergleich abschaltete.
  const vergleichbar = tage >= MIN_TAGE && vorher !== null && gesamt !== null && vorher.klicks >= MIN_KLICKS;

  let grund: string | null = null;
  if (status === "zu_frueh") {
    grund = tage === 0
      ? "Für die Zeit seit dem Anlegen liegen noch keine Ads-Daten vor."
      : `Erst ${tage} ${tage === 1 ? "Tag" : "Tage"} Daten seit dem Anlegen — unter ${MIN_TAGE} Tagen ist jede Aussage zu früh.`;
  } else if (status === "kein_traffic") {
    grund = z.state === "PAUSED"
      ? "Das Ziel ist pausiert und hatte keinen Klick."
      : "Kein einziger Klick seit dem Anlegen — Gebot zu niedrig oder kein Suchvolumen.";
  } else if (status === "wenig_traffic") {
    grund = `Nur ${eigen.klicks} Klicks seit dem Anlegen (nötig sind ${MIN_KLICKS}) — der eigene ACoS ist noch kein Messwert.`;
  } else if (vorher === null) {
    grund = "Kein Vorher-Vergleich: ein Phrase- oder Broad-Keyword fängt viele Suchbegriffe, nicht einen.";
  } else if (!vergleichbar) {
    grund = `Der Suchbegriff hatte davor nur ${vorher.klicks} Klicks — zu wenig für einen Vergleich. Das neue Ziel hat ihn erst erschlossen.`;
  }

  return {
    ziel: z.text,
    art: z.art,
    match_type: z.match_type,
    state: z.state,
    gebot: z.gebot_cents === null || z.gebot_cents === undefined ? null : r2(Number(z.gebot_cents) / 100),
    kampagne: z.campaign_name,
    angelegt: z.angelegt,
    // pulse_log = sekundengenau aus Pulse; snapshot = auf einen Tag genau.
    quelle: z.quelle,
    tage,
    status,
    grund,
    // Der Suchbegriff lief davor und ist seit dem Anlegen fast verschwunden:
    // weniger als ein Viertel der Klicks, über alle Ziele zusammen.
    begriff_eingebrochen: vergleichbar && gesamt!.klicks * 4 < vorher!.klicks,
    eigen,
    vorher,
    anderswo,
    gesamt_danach: gesamt,
    umsatz_differenz: vergleichbar ? r2(gesamt!.umsatz - vorher!.umsatz) : null,
    kosten_differenz: vergleichbar ? r2(gesamt!.kosten - vorher!.kosten) : null,
    bestellungen_differenz: vergleichbar ? gesamt!.bestellungen - vorher!.bestellungen : null,
  };
}

function tag(x: unknown): string | null {
  return typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
}

export async function adsKeywordWirkung(
  supabase: any,
  tenant_id: string,
  opts?: { von?: unknown; bis?: unknown; marktplatz?: unknown },
): Promise<unknown> {
  const kopf = await marktplatzKopf(supabase, tenant_id, opts);
  const von = tag(opts?.von) ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const bis = tag(opts?.bis) ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("ads_keyword_wirkung", {
    p_tenant: tenant_id, p_marktplatz: kopf.marktplatz, p_von: von, p_bis: bis,
  });
  if (error) throw new Error(`ads_keyword_wirkung: ${error.message}`);

  const ziele = ((data?.zeilen ?? []) as WirkungZeile[]).map(baueWirkung);
  const zaehle = (s: Status) => ziele.filter((z) => z.status === s).length;
  const mitTraffic = ziele.filter((z) => z.eigen.klicks > 0);
  const kosten = r2(mitTraffic.reduce((n, z) => n + z.eigen.kosten, 0));
  const umsatz = r2(mitTraffic.reduce((n, z) => n + z.eigen.umsatz, 0));

  return {
    ...kopf,
    zeitraum: { von, bis },
    daten_bis: data?.letzter_tag ?? null,
    anzahl: ziele.length,
    bilanz: {
      auswertbar: zaehle("auswertbar"), wenig_traffic: zaehle("wenig_traffic"),
      kein_traffic: zaehle("kein_traffic"), zu_frueh: zaehle("zu_frueh"),
      // Nur das, was über die neuen Ziele selbst lief — nicht, was sie "gebracht" haben.
      eigen: {
        kosten, umsatz,
        bestellungen: mitTraffic.reduce((n, z) => n + z.eigen.bestellungen, 0),
        acos: umsatz > 0 ? Math.round((kosten / umsatz) * 10000) / 10000 : null,
      },
    },
    ziele,
    hinweise: [
      "`gesamt_danach` (das neue Ziel plus derselbe Suchbegriff über andere Ziele) gegen `vorher` "
      + "ist der ehrliche Vergleich: ein Exact-Keyword, das Bestellungen nur aus einer anderen "
      + "Kampagne herüberzieht, hat nichts gewonnen. Und auch das ist ein Nebeneinander, kein Beweis.",
      "Das Anlagedatum stammt aus dem Pulse-Protokoll (`pulse_log`, sekundengenau) oder aus dem "
      + "täglichen Struktur-Snapshot (`snapshot`, auf einen Tag genau, erst seit dem 04.10.2026). "
      + "Was vor diesem Tag in der Amazon-Konsole angelegt wurde, kennt die Liste nicht.",
      `Ads-Daten liegen bis ${data?.letzter_tag ?? "—"} vor. Die Fenster enden dort; die letzten `
      + "drei Tage davon passt Amazon noch an.",
    ],
  };
}

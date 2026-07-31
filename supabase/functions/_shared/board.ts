// board.ts — Board-Report (DataDoe #6). Der geld-fokussierte Einseiter fürs
// monatliche Review: Ampel + Umsatz-KPIs oben, darunter die drei fertigen
// €-Radare (Erstattungen, Nachschub, Ladenhüter) und eine priorisierte
// „Geld auf dem Tisch"-Liste mit konkreter Handlung je Position.
//
// Bewusst KOMPOSITION: baueBoardReport(...) ist rein und nimmt die schon
// geladenen Ergebnisse der getesteten Aggregatoren — keine neue Datenlogik.
// Abgrenzung: Wochenbrief = operativ (Diagnosen/Aufgaben/Änderungen);
// Board-Report = finanziell (Leaks in €, was bringt das meiste Geld zurück).

import { pulseOverview } from "./overview.ts";
import { radarDaten } from "./reimbursements.ts";
import { stockoutRadar } from "./stockouts.ts";
import { ladenhueterRadar } from "./ladenhueter.ts";

interface Prio {
  quelle: "erstattung" | "nachschub" | "ladenhueter";
  asin: string;
  titel: string;
  betrag_cents: number;
  betrag_art: "einmalig" | "laufend" | "monatlich";
  aktion: string;
}

function nz(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Baut den Board-Report aus bereits geladenen Bausteinen. Rein & deterministisch. */
export function baueBoardReport(overview: any, erstattung: any, nachschub: any, ladenhueter: any): Record<string, unknown> {
  const erstattungOffen = nz(erstattung?.summe_geschaetzt_cents);
  const nachschubLaufend = nz(nachschub?.summe_laufend_cents);
  const ladenEinbruch = nz(ladenhueter?.summe_einbruch_cents);

  // Priorisierte Positionen quer über die drei Radare (größter Betrag zuerst).
  const prio: Prio[] = [];
  for (const z of (nachschub?.zeilen ?? []) as any[]) {
    if (z.status === "leer" && nz(z.verlust_cents) > 0) {
      prio.push({ quelle: "nachschub", asin: String(z.asin), titel: String(z.produktname ?? z.asin), betrag_cents: nz(z.verlust_cents), betrag_art: "laufend", aktion: "Nachbestellen — Verkäufe abgebrochen" });
    }
  }
  for (const k of (erstattung?.kandidaten ?? []) as any[]) {
    if (nz(k.geschaetzt_cents) > 0) {
      prio.push({ quelle: "erstattung", asin: String(k.asin), titel: String(k.produktname ?? k.asin), betrag_cents: nz(k.geschaetzt_cents), betrag_art: "einmalig", aktion: "Erstattung in Seller Central beantragen" });
    }
  }
  for (const z of (ladenhueter?.zeilen ?? []) as any[]) {
    if (nz(z.einbruch_cents) <= 0) continue;
    // Aktion folgt dem ECHTEN Status, nicht dem Radar-Namen: ein Ausverkauf
    // („wiederanlauf") braucht Nachschub, NICHT „auslisten".
    const status = String(z.status ?? "");
    const istAusverkauf = status === "wiederanlauf";
    prio.push({
      quelle: istAusverkauf ? "nachschub" : "ladenhueter",
      asin: String(z.asin),
      titel: String(z.produktname ?? z.asin),
      betrag_cents: nz(z.einbruch_cents),
      betrag_art: "monatlich",
      aktion: istAusverkauf
        ? "Bestand sichern — war ausverkauft, läuft wieder an"
        : status === "tot"
        ? "Auslisten prüfen — seit über 60 Tagen kein Verkauf"
        : "Relaunch prüfen (Bild/Preis/PPC) oder auslisten",
    });
  }
  prio.sort((a, b) => b.betrag_cents - a.betrag_cents);

  return {
    erstellt_am: new Date().toISOString(),
    ampel: overview?.status ?? null,
    zeitraum: overview?.zeitraum ?? null,
    is_provisional: overview?.is_provisional ?? false,
    kpis: {
      umsatz: overview?.kpis?.umsatz ?? null,
      waehrung: overview?.kpis?.waehrung ?? "EUR",
      sessions: overview?.kpis?.sessions ?? null,
      unitsOrdered: overview?.kpis?.unitsOrdered ?? null,
      cvr: overview?.kpis?.cvr ?? null,
      retourenquote: overview?.kpis?.retourenquote ?? null,
    },
    leaks: {
      erstattungen: {
        offen_cents: erstattungOffen,
        erstattet_cents: nz(erstattung?.erstattet_gesamt_cents),
        anzahl_kandidaten: (erstattung?.kandidaten ?? []).length,
      },
      nachschub: {
        laufend_cents: nachschubLaufend,
        anzahl_leer: nz(nachschub?.anzahl_leer),
        anzahl_kritisch: nz(nachschub?.anzahl_kritisch),
      },
      ladenhueter: {
        einbruch_cents: ladenEinbruch,
        anzahl_tot: nz(ladenhueter?.anzahl_tot),
        anzahl_abkuehlend: nz(ladenhueter?.anzahl_abkuehlend),
      },
      // Grobe Summe unterschiedlicher Signale (einmalig + laufend + monatlich) —
      // im Frontend als „grob" gekennzeichnet, nur zur Größenordnung.
      summe_handlungsbedarf_cents: erstattungOffen + nachschubLaufend + ladenEinbruch,
    },
    prioritaeten: prio.slice(0, 8),
  };
}

/** Lädt die Bausteine parallel und baut den Report. */
export async function boardReport(supabase: any, tenant_id: string): Promise<unknown> {
  const [overview, erstattung, nachschub, ladenhueter] = await Promise.all([
    pulseOverview(supabase, tenant_id) as Promise<any>,
    radarDaten(supabase, tenant_id) as Promise<any>,
    stockoutRadar(supabase, tenant_id) as Promise<any>,
    ladenhueterRadar(supabase, tenant_id) as Promise<any>,
  ]);
  return baueBoardReport(overview, erstattung, nachschub, ladenhueter);
}

// Tests für ads_verlauf.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Der Supabase-Client wird durch einen Doppelgänger ersetzt, der die Antwort von
// ads_summen nachstellt. Geprüft wird das, was hier tatsächlich entschieden
// wird: Zeitraum-Auflösung, Zuordnung der Ebenen, Sortierung und die ehrlichen
// Warnungen bei Datenlücken.

import { assertEquals } from "jsr:@std/assert@1";
import { adsVerlauf, zeitraumAus } from "./ads_verlauf.ts";

function client(rows: unknown[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      rpc: (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve({ data: rows, error: null });
      },
    } as any,
  };
}

function summe(o: {
  ebene: string; schluessel?: string | null; bezeichnung?: string | null;
  impressions?: number; clicks?: number; spend?: number; sales?: number;
  orders?: number; einheiten?: number;
}) {
  return {
    ebene: o.ebene,
    schluessel: o.schluessel ?? null,
    bezeichnung: o.bezeichnung ?? null,
    impressions: o.impressions ?? 0,
    clicks: o.clicks ?? 0,
    // bigint kommt über PostgREST als String — genau so nachstellen.
    spend_cents: String(o.spend ?? 0),
    sales_cents: String(o.sales ?? 0),
    orders: o.orders ?? 0,
    einheiten: o.einheiten ?? 0,
  };
}

// --- zeitraumAus ---

Deno.test("Zeitraum: von/bis werden uebernommen", () => {
  assertEquals(zeitraumAus({ von: "2026-06-01", bis: "2026-06-30" }), { von: "2026-06-01", bis: "2026-06-30" });
});

Deno.test("Zeitraum: verdrehte Grenzen werden getauscht", () => {
  assertEquals(zeitraumAus({ von: "2026-06-30", bis: "2026-06-01" }), { von: "2026-06-01", bis: "2026-06-30" });
});

Deno.test("Zeitraum: unbrauchbare Datumsangaben fallen aufs Preset zurueck", () => {
  const r = zeitraumAus({ von: "01.06.2026", bis: "30.06.2026" });
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(r.von), true);
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(r.bis), true);
});

Deno.test("Zeitraum: halbes Paar zaehlt nicht als frei gewaehlt", () => {
  // Nur `von` ohne `bis` waere zweideutig — dann gilt das Preset.
  const r = zeitraumAus({ von: "2026-06-01", tage: 7 });
  assertEquals(r.von === "2026-06-01", false);
});

// --- adsVerlauf ---

const ZEITRAUM = { von: "2026-06-01", bis: "2026-06-03" };

Deno.test("Verlauf: Ebenen werden getrennt und Geld in Euro gerechnet", async () => {
  const c = client([
    summe({ ebene: "gesamt", impressions: 1000, clicks: 50, spend: 2500, sales: 10000, orders: 4 }),
    summe({ ebene: "tag", schluessel: "2026-06-02", clicks: 20, spend: 1000, sales: 4000 }),
    summe({ ebene: "tag", schluessel: "2026-06-01", clicks: 30, spend: 1500, sales: 6000 }),
    summe({ ebene: "kampagne", schluessel: "C1", bezeichnung: "Kampagne A", spend: 2500, sales: 10000 }),
    summe({ ebene: "asin", schluessel: "B001", spend: 2500, sales: 10000 }),
  ]);
  const r = await adsVerlauf(c.client, "t", ZEITRAUM) as any;

  assertEquals(r.zeitraum, ZEITRAUM);
  assertEquals(r.gesamt.spend, 25);
  assertEquals(r.gesamt.sales, 100);
  assertEquals(r.gesamt.acos, 25);
  assertEquals(r.gesamt.roas, 4);
  assertEquals(r.tage_mit_daten, 2);
  // Tage aufsteigend, unabhaengig von der Reihenfolge aus der Datenbank.
  assertEquals(r.proTag.map((t: any) => t.datum), ["2026-06-01", "2026-06-02"]);
  assertEquals(r.proKampagne[0].campaignName, "Kampagne A");
  assertEquals(r.proAsin[0].asin, "B001");
});

Deno.test("Verlauf: Kampagnen und ASINs nach Spend sortiert", async () => {
  const c = client([
    summe({ ebene: "gesamt", spend: 3000 }),
    summe({ ebene: "kampagne", schluessel: "klein", spend: 1000 }),
    summe({ ebene: "kampagne", schluessel: "gross", spend: 2000 }),
    summe({ ebene: "asin", schluessel: "B-klein", spend: 1000 }),
    summe({ ebene: "asin", schluessel: "B-gross", spend: 2000 }),
  ]);
  const r = await adsVerlauf(c.client, "t", ZEITRAUM) as any;
  assertEquals(r.proKampagne.map((k: any) => k.campaignId), ["gross", "klein"]);
  assertEquals(r.proAsin.map((a: any) => a.asin), ["B-gross", "B-klein"]);
});

Deno.test("Verlauf: leerer Zeitraum ergibt Nullen und eine Warnung", async () => {
  const c = client([summe({ ebene: "gesamt" })]);
  const r = await adsVerlauf(c.client, "t", ZEITRAUM) as any;
  assertEquals(r.tage_mit_daten, 0);
  assertEquals(r.gesamt.spend, 0);
  // Kein Umsatz -> ACOS ist unbekannt, nicht 0.
  assertEquals(r.gesamt.acos, null);
  assertEquals(r.warnungen.some((w: string) => w.includes("Keine Ads-Daten")), true);
});

Deno.test("Verlauf: Datenluecken am Rand werden benannt, nicht als 0 ausgegeben", async () => {
  // Angefragt 01.-03.06., Daten nur am 02.06. — beide Raender fehlen.
  const c = client([
    summe({ ebene: "gesamt", spend: 1000 }),
    summe({ ebene: "tag", schluessel: "2026-06-02", spend: 1000 }),
  ]);
  const r = await adsVerlauf(c.client, "t", ZEITRAUM) as any;
  assertEquals(r.proTag.length, 1);
  assertEquals(r.warnungen.some((w: string) => w.includes("beginnen erst am 2026-06-02")), true);
  assertEquals(r.warnungen.some((w: string) => w.includes("enden am 2026-06-02")), true);
});

Deno.test("Verlauf: fragt ads_summen mit dem aufgeloesten Zeitraum", async () => {
  const c = client([summe({ ebene: "gesamt" })]);
  await adsVerlauf(c.client, "tenant-1", ZEITRAUM);
  assertEquals(c.calls[0].name, "ads_summen");
  assertEquals(c.calls[0].args, { p_tenant: "tenant-1", p_von: "2026-06-01", p_bis: "2026-06-03" });
});

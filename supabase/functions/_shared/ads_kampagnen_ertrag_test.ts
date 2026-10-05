// Tests für ads_kampagnen_ertrag.ts. Zahlen: Vanejas Kratzbrett, 30 Tage bis 01.10.2026.

import { assertEquals } from "jsr:@std/assert@1";
import { baueKampagnenErtrag, bilanzAus, type SummenZeile } from "./ads_kampagnen_ertrag.ts";

const z = (campaign_name: string, modus: "h10" | "pulse", clicks: number, spend_cents: number, sales_cents: number, orders: number): SummenZeile =>
  ({ campaign_id: campaign_name, campaign_name, ad_product: "SP", produkt: "Kratzbrett", modus, impressions: 1000, clicks, spend_cents, sales_cents, orders, tage_aktiv: 30 });

const MARGE = 0.3253; // Kratzbrett, 90 Tage

Deno.test("Ertrag: ACoS gegen die Marge des Produkts", () => {
  // Hauptkampagne: 463,08 EUR Kosten, 1.423,62 EUR Umsatz — 32,5 % ACoS, knapp unter 32,53 %.
  const haupt = baueKampagnenErtrag(z("SP_kw_exact", "h10", 372, 46308, 142362, 85), MARGE);
  assertEquals(haupt.acos, 0.3253);
  assertEquals(haupt.db_nach_werbung, 0.02);
  // Broad: 56,8 % ACoS.
  const broad = baueKampagnenErtrag(z("CP-sp_kw_broad", "h10", 163, 18293, 32214, 19), MARGE);
  assertEquals(broad.einordnung, "ueber_break_even");
  assertEquals(broad.db_nach_werbung, -78.14);
  // SB Video: 32 % ACoS.
  const video = baueKampagnenErtrag(z("CP-SB_VIDEO", "h10", 84, 7882, 24664, 15), MARGE);
  assertEquals(video.einordnung, "traegt_sich");
  assertEquals(video.db_nach_werbung, 1.41);
});

Deno.test("Ertrag: ohne Bestellung zählen die Kosten; wenige Klicks sind kein Befund; ohne Marge unbekannt", () => {
  const wenig = baueKampagnenErtrag(z("SP-Kratzmatte-Cluster", "pulse", 1, 70, 0, 0), MARGE);
  assertEquals(wenig.einordnung, "wenig_daten");
  assertEquals(wenig.db_nach_werbung, -0.7);
  assertEquals(wenig.acos, null);
  const leer = baueKampagnenErtrag(z("Auto", "pulse", 25, 1500, 0, 0), null);
  assertEquals(leer.einordnung, "ohne_bestellung");
  assertEquals(leer.db_nach_werbung, -15);
  const neu = baueKampagnenErtrag(z("SP_Exact_Core", "h10", 30, 1800, 5000, 4), null);
  assertEquals(neu.einordnung, "marge_unbekannt");
  assertEquals(neu.db_nach_werbung, null);

  const b = bilanzAus([wenig, leer, neu, baueKampagnenErtrag(z("CP-sp_kw_broad", "h10", 163, 18293, 32214, 19), MARGE)]);
  assertEquals(b.ueber_break_even, { anzahl: 1, db_nach_werbung: -78.14 });
  assertEquals(b.ohne_bestellung, { anzahl: 1, kosten: 15 });
  assertEquals([b.wenig_daten, b.marge_unbekannt, b.traegt_sich.anzahl], [1, 1, 0]);
});

import { assertEquals } from "jsr:@std/assert@1";
import { bewerteAsin, REICHWEITE_KNAPP_TAGE } from "./stockouts.ts";

function inp(over: Partial<Parameters<typeof bewerteAsin>[0]> = {}) {
  return { velo_tag: 1, tage_ohne_verkauf: 0, avg_preis_cents: 1000, buybox_pct: null, sessions: null, ...over };
}

Deno.test("zu geringe Velocity -> ok (Nulltage sind normal)", () => {
  const b = bewerteAsin(inp({ velo_tag: 0.2, tage_ohne_verkauf: 30 }));
  assertEquals(b.status, "ok");
  assertEquals(b.verlust_cents, 0);
});

// --- Mit echten Lagerdaten ---

Deno.test("Lager leer UND nichts bestellt -> dringendster Status", () => {
  // Echter Fall B0FKNN9CCJ: velo 2,0 · Bestand 0 · nichts unterwegs.
  const b = bewerteAsin(inp({
    velo_tag: 2, tage_ohne_verkauf: 3, avg_preis_cents: 4000,
    bestand: 0, nachschub_unterwegs: 0, bestand_bekannt: true, reichweite_tage: 0,
  }));
  assertEquals(b.status, "leer_ohne_nachschub");
  assertEquals(b.schwere, 5);
  assertEquals(b.verlust_cents, Math.round(2 * 3 * 4000));
  assertEquals(b.verlust_art, "laufend");
});

Deno.test("Lager leer, aber Ware unterwegs -> geringere Dringlichkeit", () => {
  // Echter Fall B0H15QMFP1: Bestand 0, 75 unterwegs.
  const b = bewerteAsin(inp({
    velo_tag: 1.067, tage_ohne_verkauf: 1, avg_preis_cents: 2897,
    bestand: 0, nachschub_unterwegs: 75, bestand_bekannt: true, reichweite_tage: 0,
  }));
  assertEquals(b.status, "leer_mit_nachschub");
  assertEquals(b.schwere, 3);
  assertEquals(b.verlust_cents > 0, true); // Verlust ist real, nur adressiert
});

Deno.test("leeres Lager kostet ab Tag 1, auch wenn heute noch verkauft wurde", () => {
  const b = bewerteAsin(inp({ velo_tag: 2, tage_ohne_verkauf: 0, avg_preis_cents: 1000, bestand: 0, nachschub_unterwegs: 0, bestand_bekannt: true }));
  assertEquals(b.verlust_cents, 2000); // mind. 1 Tag
});

Deno.test("Reichweite knapp und nichts bestellt -> Warnung ohne Verlustbetrag", () => {
  // Echter Fall B0FDG6499X: 18 Stueck, 1,25/Tag = 14,4 Tage, nichts unterwegs.
  const b = bewerteAsin(inp({
    velo_tag: 1.247, tage_ohne_verkauf: 9, avg_preis_cents: 1500,
    bestand: 18, nachschub_unterwegs: 0, bestand_bekannt: true, reichweite_tage: 14.4,
  }));
  assertEquals(b.status, "reichweite_knapp");
  assertEquals(b.verlust_cents, 0); // noch nichts verloren — es ist eine Frist
});

Deno.test("Reichweite knapp, aber Ware unterwegs -> kein Alarm", () => {
  // B0FLKN42D4: 12,6 Tage Reichweite, aber 288 unterwegs.
  const b = bewerteAsin(inp({
    velo_tag: 10, tage_ohne_verkauf: 0, bestand: 127, nachschub_unterwegs: 288,
    bestand_bekannt: true, reichweite_tage: 12.6,
  }));
  assertEquals(b.status, "ok");
});

Deno.test("ausreichende Reichweite -> ok", () => {
  const b = bewerteAsin(inp({
    velo_tag: 1, tage_ohne_verkauf: 0, bestand: 200, nachschub_unterwegs: 0,
    bestand_bekannt: true, reichweite_tage: REICHWEITE_KNAPP_TAGE + 10,
  }));
  assertEquals(b.status, "ok");
});

Deno.test("Bestand vorhanden, aber Buy-Box verloren -> buybox schlaegt durch", () => {
  const b = bewerteAsin(inp({
    velo_tag: 1, tage_ohne_verkauf: 1, bestand: 500, nachschub_unterwegs: 0,
    bestand_bekannt: true, reichweite_tage: 500, buybox_pct: 50, sessions: 100,
  }));
  assertEquals(b.status, "buybox");
});

// --- Ohne Lagerdaten: Rueckfall auf die Verkaufsluecke ---

Deno.test("ohne Bestandsdaten: >= 7 Tage ohne Verkauf -> leer (geschlossen)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1.5, tage_ohne_verkauf: 10, avg_preis_cents: 6879 }));
  assertEquals(b.status, "leer");
  assertEquals(b.schwere, 4);
  assertEquals(b.verlust_cents, Math.round(1.5 * 10 * 6879));
});

Deno.test("ohne Bestandsdaten: 4-6 Tage -> kritisch", () => {
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 5 }));
  assertEquals(b.status, "kritisch");
  assertEquals(b.verlust_cents, 0);
});

Deno.test("ohne Bestandsdaten: laenger als 45 Tage tot -> ok (Ladenhueter #5)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1.5, tage_ohne_verkauf: 70, avg_preis_cents: 5000 }));
  assertEquals(b.status, "ok");
});

Deno.test("Buy-Box-Verlust bei Traffic -> Monatsrate", () => {
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 1, buybox_pct: 50, sessions: 100 }));
  assertEquals(b.status, "buybox");
  assertEquals(b.verlust_art, "monatsrate");
  assertEquals(b.verlust_cents, 30000);
});

Deno.test("niedrige Buy-Box aber kaum Traffic -> ok (nicht relevant)", () => {
  const b = bewerteAsin(inp({ velo_tag: 1, tage_ohne_verkauf: 1, buybox_pct: 50, sessions: 5 }));
  assertEquals(b.status, "ok");
});

Deno.test("Buy-Box-Anteil ist bei 1 gedeckelt", () => {
  const b = bewerteAsin(inp({ velo_tag: 2, tage_ohne_verkauf: 1, avg_preis_cents: 500, buybox_pct: 10, sessions: 50 }));
  assertEquals(b.verlust_cents, 30000);
});

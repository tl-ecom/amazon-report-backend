// Tests für betriebskosten.ts — ausführen mit:  npx deno@2 test supabase/functions/_shared/
//
// Der Kern ist die Netto-Brutto-Trennung. Amazon liefert zwei Formate, und nur
// eines davon weist die Steuer aus. Ein gerechneter Wert darf nicht aussehen
// wie ein abgelesener — genau das prüfen diese Tests.
//
// Zahlen bewusst rund: 119 brutto sind bei 19 % genau 100 netto.

import { assertEquals } from "jsr:@std/assert@1";
import { baueBetriebskosten } from "./betriebskosten.ts";

const UST = 1.19;

function zeile(o: {
  kategorie: string;
  netto?: number;   // 'Base fee', in Cent
  steuer?: number;  // 'Tax on fee', in Cent
  ohne?: number;    // Einzelzeile ohne Steuerausweis, in Cent
  zeilen?: number;
}) {
  return {
    kategorie: o.kategorie,
    netto_ausgewiesen_cents: o.netto ?? 0,
    steuer_ausgewiesen_cents: o.steuer ?? 0,
    brutto_ohne_ausweis_cents: o.ohne ?? 0,
    zeilen: o.zeilen ?? 1,
  };
}

Deno.test("Neues Format: Steuer ist ausgewiesen, nichts wird gerechnet", () => {
  const r = baueBetriebskosten([zeile({ kategorie: "lagerung", netto: -10000, steuer: -1900 })], UST);
  const p = r.posten[0];
  assertEquals(p.netto, -100);
  assertEquals(p.brutto, -119);
  assertEquals(p.steuer, -19);
  assertEquals(p.steuer_gerechnet, false);
});

Deno.test("Altes Format: aus dem Brutto wird netto gerechnet und gekennzeichnet", () => {
  const r = baueBetriebskosten([zeile({ kategorie: "anlieferung", ohne: -11900 })], UST);
  const p = r.posten[0];
  assertEquals(p.netto, -100);
  assertEquals(p.brutto, -119);
  assertEquals(p.steuer_gerechnet, true);
  assertEquals(r.hinweise.some((h) => h.includes("gerechnet")), true);
});

Deno.test("Beide Formate im selben Posten werden zusammengefuehrt", () => {
  // Genau der reale Fall: Amazon hat das Format zwischen zwei Abrechnungen
  // gewechselt, beide Varianten liegen im selben Zeitraum.
  const r = baueBetriebskosten(
    [zeile({ kategorie: "anlieferung", netto: -10000, steuer: -1900, ohne: -11900 })],
    UST,
  );
  const p = r.posten[0];
  assertEquals(p.netto, -200);
  assertEquals(p.brutto, -238);
  assertEquals(p.steuer_gerechnet, true);
});

Deno.test("Erstattungen werden NICHT durch den Steuerfaktor geteilt", () => {
  // Eine Gutschrift ist keine Gebuehr. Sie zu teilen waere eine Behauptung
  // ueber ihre steuerliche Behandlung, die die Abrechnung nicht hergibt.
  const r = baueBetriebskosten([zeile({ kategorie: "erstattungen", ohne: 11900 })], UST);
  const p = r.posten[0];
  assertEquals(p.netto, 119);
  assertEquals(p.brutto, 119);
  assertEquals(p.steuer, 0);
  assertEquals(p.steuer_gerechnet, false);
});

Deno.test("Ohne Steuerprofil bleibt der Betrag unveraendert", () => {
  // nettoGebuehr laesst ohne gueltigen Faktor den Betrag stehen — nie
  // stillschweigend umrechnen.
  const r = baueBetriebskosten([zeile({ kategorie: "anlieferung", ohne: -11900 })], null);
  assertEquals(r.posten[0].netto, -119);
  assertEquals(r.posten[0].brutto, -119);
});

Deno.test("Kategorien erscheinen in fester Reihenfolge: Kosten zuerst, Gutschrift zuletzt", () => {
  const r = baueBetriebskosten([
    zeile({ kategorie: "erstattungen", ohne: 100 }),
    zeile({ kategorie: "lagerung", netto: -100 }),
    zeile({ kategorie: "anlieferung", netto: -100 }),
  ], UST);
  assertEquals(r.posten.map((p) => p.kategorie), ["anlieferung", "lagerung", "erstattungen"]);
});

Deno.test("Bezeichnungen sind lesbar, nicht die Schluessel", () => {
  const r = baueBetriebskosten([zeile({ kategorie: "langzeitlagerung", netto: -100 })], UST);
  assertEquals(r.posten[0].bezeichnung, "Langzeit-Lagergebühren");
});

Deno.test("Summen zaehlen Kosten und Gutschriften gegeneinander", () => {
  const r = baueBetriebskosten([
    zeile({ kategorie: "anlieferung", netto: -10000, steuer: -1900 }),
    zeile({ kategorie: "erstattungen", ohne: 5000 }),
  ], UST);
  assertEquals(r.summe_netto, -50);
  assertEquals(r.summe_brutto, -69);
});

Deno.test("Leerer Zeitraum wird benannt, nicht als 0 ausgegeben", () => {
  const r = baueBetriebskosten([], UST);
  assertEquals(r.posten, []);
  assertEquals(r.hinweise.some((h) => h.includes("Keine Betriebskosten")), true);
});

Deno.test("Betraege kommen als String durch (bigint ueber PostgREST)", () => {
  const r = baueBetriebskosten(
    [{ kategorie: "lagerung", netto_ausgewiesen_cents: "-10000", steuer_ausgewiesen_cents: "-1900", brutto_ohne_ausweis_cents: "0", zeilen: "3" }],
    UST,
  );
  assertEquals(r.posten[0].netto, -100);
  assertEquals(r.posten[0].buchungen, 3);
});

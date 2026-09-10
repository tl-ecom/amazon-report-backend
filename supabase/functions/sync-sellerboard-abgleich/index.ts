// sync-sellerboard-abgleich — monatliche Gegenprobe der Pulse-Zahlen.
//
// Pulse und Sellerboard rechnen dieselben Größen aus denselben Amazon-Daten,
// aber mit eigener Logik. Solange beide übereinstimmen, ist das kein Beweis für
// Richtigkeit — aber wenn sie auseinanderlaufen, stimmt bei einem von beiden
// etwas nicht, und das ist ein Hinweis, den man sonst nie bekommt.
//
// Der erste Lauf hat sich sofort bezahlt gemacht: Umsatz und Einheiten stimmten
// auf unter einem Prozent, die Werbekosten wichen um 18 % ab — Pulse zählte nur
// Sponsored Products, Sellerboard auch Brands und Display.
//
// Läuft monatlich. Häufiger wäre sinnlos: Sellerboards Zahlen für einen Monat
// stehen erst fest, wenn Amazon ihn abgerechnet hat.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  leseSellerboard, vergleiche, zusammenfassung,
  type Befund, type PulseMonat,
} from "../_shared/sellerboard_abgleich.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Sellerboards Automation-Link erzeugt den Bericht beim ersten Abruf und
 * antwortet solange mit "Report not ready, try again in several minutes".
 * Gemessen: der zweite Versuch nach wenigen Sekunden hatte die Daten.
 */
const NICHT_BEREIT = "Report not ready";
const VERSUCHE = 4;
const WARTE_MS = 15000;

async function holeCsv(url: string): Promise<{ csv: string | null; grund: string }> {
  for (let i = 1; i <= VERSUCHE; i++) {
    const antwort = await fetch(url);
    const text = await antwort.text();
    if (!antwort.ok) {
      return { csv: null, grund: `HTTP ${antwort.status} von Sellerboard` };
    }
    if (!text.includes(NICHT_BEREIT)) return { csv: text, grund: "ok" };
    if (i < VERSUCHE) await new Promise((r) => setTimeout(r, WARTE_MS));
  }
  return {
    csv: null,
    grund: `Sellerboard hat den Bericht nach ${VERSUCHE} Versuchen nicht `
      + "fertiggestellt. Kein Fehler, nur noch nicht bereit.",
  };
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({}));
  const nurTenant = (body?.tenant_id as string) ?? null;

  const { data: mandanten } = await supabase
    .from("tenant_einstellungen")
    .select("tenant_id, sellerboard_dashboard_url_secret")
    .not("sellerboard_dashboard_url_secret", "is", null);

  const ergebnisse: unknown[] = [];

  for (const m of mandanten ?? []) {
    if (nurTenant && m.tenant_id !== nurTenant) continue;

    const merke = async (status: string) => {
      await supabase.from("tenant_einstellungen").update({
        sellerboard_dashboard_zuletzt: new Date().toISOString(),
        sellerboard_dashboard_status: status,
      }).eq("tenant_id", m.tenant_id);
    };

    try {
      const { data: url } = await supabase.rpc("read_vault_secret", {
        p_secret_id: m.sellerboard_dashboard_url_secret,
      });
      if (!url) {
        await merke("Link nicht lesbar");
        ergebnisse.push({ tenant_id: m.tenant_id, fehler: "Link nicht lesbar" });
        continue;
      }

      const { csv, grund } = await holeCsv(String(url));
      if (!csv) {
        await merke(grund);
        ergebnisse.push({ tenant_id: m.tenant_id, fehler: grund });
        continue;
      }

      const sbMonate = leseSellerboard(csv);
      if (sbMonate.length === 0) {
        await merke("CSV ohne verwertbare Zeilen");
        ergebnisse.push({ tenant_id: m.tenant_id, fehler: "CSV ohne verwertbare Zeilen" });
        continue;
      }

      const { data: pulseRoh } = await supabase.rpc("pulse_monatszahlen", {
        p_tenant: m.tenant_id, p_monate: 6,
      });
      const pulse = new Map<string, any>();
      for (const p of (pulseRoh ?? []) as any[]) pulse.set(p.monat, p);

      const zeilen: any[] = [];
      const meldungen: string[] = [];

      for (const sb of sbMonate) {
        const p = pulse.get(sb.monat);
        if (!p) continue;
        const eigen: PulseMonat = {
          monat: sb.monat,
          umsatz_cents: Number(p.umsatz_cents),
          einheiten: Number(p.einheiten),
          werbung_cents: Number(p.werbung_cents),
          gebuehren_cents: Number(p.gebuehren_cents),
          ust_cents: Number(p.ust_cents),
        };
        const befunde: Befund[] = vergleiche(eigen, sb);

        for (const b of befunde) {
          zeilen.push({
            tenant_id: m.tenant_id, monat: sb.monat, kennzahl: b.kennzahl,
            pulse_cents: b.pulse_cents, sellerboard_cents: b.sellerboard_cents,
            abweichung_prozent: b.abweichung_prozent, bewertung: b.bewertung,
            geprueft_am: new Date().toISOString(),
          });
        }

        // Ein Monat mit niedriger Abdeckung MUSS abweichen — das ist Verzug,
        // kein Fehler. Ihn zu melden hiesse, jeden Monat dieselbe Mail zu
        // schicken, bis niemand mehr hinsieht.
        const abdeckung = Number(p.abdeckung ?? 0);
        if (abdeckung >= 0.8) {
          const text = zusammenfassung(sb.monat, befunde);
          if (text) meldungen.push(text);
        }
      }

      if (zeilen.length > 0) {
        await supabase.from("sellerboard_abgleich")
          .upsert(zeilen, { onConflict: "tenant_id,monat,kennzahl" });
      }
      await merke(meldungen.length > 0 ? `Abweichungen: ${meldungen.length}` : "ok");
      ergebnisse.push({
        tenant_id: m.tenant_id, monate: sbMonate.length,
        zeilen: zeilen.length, meldungen,
      });
    } catch (e) {
      const grund = String((e as Error)?.message ?? e);
      await merke(`Fehler: ${grund}`.slice(0, 200));
      ergebnisse.push({ tenant_id: m.tenant_id, fehler: grund });
    }
  }

  return new Response(JSON.stringify({ ok: true, ergebnisse }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});

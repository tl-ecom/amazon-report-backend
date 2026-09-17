// gebotsautomatik_lauf.ts — DB-Schicht der Gebotsautomatik (Stufe 1).
//
// Holt Regeln und Leistungsdaten, laesst gebotsautomatik.ts rechnen und legt
// das Ergebnis in ads_gebot_vorschlaege ab. SCHREIBT NICHTS NACH AMAZON —
// der einzige Schreibweg dorthin bleibt die Function ads-gebote.

import {
  berechneVorschlaege,
  bilanz,
  type GruppenLeistung,
  type PlatzierungsAnteil,
  type Regel,
  type Vorschlag,
  type ZielLeistung,
} from "./gebotsautomatik.ts";

/** Spaltennamen aus ads_kampagnen auf die Platzierungen des Berichts abbilden. */
const MOD_SPALTE: Record<string, string> = {
  "Top of Search on-Amazon": "mod_top_prozent",
  "Detail Page on-Amazon": "mod_produktseite_prozent",
  "Other on-Amazon": "mod_rest_prozent",
};

const cents = (x: number | null | undefined): number | null =>
  x === null || x === undefined ? null : Number(x) / 100;

const zuCents = (x: number | null): number | null =>
  x === null ? null : Math.round(x * 100);

export interface LaufErgebnis {
  campaign_id: string;
  regel: { ziel_acos: number; min_gebot: number; max_gebot: number; fenster: string };
  aufschlag_gewichtet: number;
  bilanz: ReturnType<typeof bilanz>;
  vorschlaege: Vorschlag[];
}

/**
 * Fenster bestimmen: `fenster_tage` zurueck, aber die juengsten `karenz_tage`
 * ausgeschnitten. Ohne diesen Schnitt misst man zu schlecht — Amazon bucht
 * Umsaetze bis zu drei Tage nach, SP attribuiert ueber sieben.
 */
export function fenster(heute: Date, fensterTage: number, karenzTage: number) {
  const tag = (d: Date) => d.toISOString().slice(0, 10);
  const bis = new Date(heute);
  bis.setUTCDate(bis.getUTCDate() - karenzTage);
  const von = new Date(bis);
  von.setUTCDate(von.getUTCDate() - (fensterTage - 1));
  return { von: tag(von), bis: tag(bis) };
}

/** Platzierungszeilen der RPC in die Form bringen, die das Rechenmodul braucht. */
export function baueAnteile(zeilen: any[]): PlatzierungsAnteil[] {
  return zeilen.map((z) => {
    const spalte = MOD_SPALTE[String(z.platzierung)];
    const prozent = spalte ? Number(z[spalte] ?? 0) : 0;
    return {
      platzierung: String(z.platzierung),
      klicks: Number(z.klicks ?? 0),
      modifikator: (Number.isFinite(prozent) ? prozent : 0) / 100,
    };
  });
}

/** Einen Lauf fuer eine Kampagne rechnen. Schreibt nicht. */
export async function rechneKampagne(
  supabase: any, tenantId: string, regelZeile: any, heute = new Date(),
): Promise<LaufErgebnis> {
  const regel: Regel = {
    campaign_id: String(regelZeile.campaign_id),
    ziel_acos: Number(regelZeile.ziel_acos),
    min_gebot: Number(regelZeile.min_gebot_cents) / 100,
    max_gebot: Number(regelZeile.max_gebot_cents) / 100,
    max_schritt_prozent: Number(regelZeile.max_schritt_prozent),
    min_klicks: Number(regelZeile.min_klicks),
  };
  const { von, bis } = fenster(
    heute, Number(regelZeile.fenster_tage), Number(regelZeile.karenz_tage),
  );
  const args = { p_tenant: tenantId, p_von: von, p_bis: bis, p_campaigns: [regel.campaign_id] };

  const [zieleRes, gruppenRes, platzRes] = await Promise.all([
    supabase.rpc("ads_automatik_ziele", args),
    supabase.rpc("ads_automatik_gruppen", args),
    supabase.rpc("ads_automatik_platzierungen", args),
  ]);
  for (const r of [zieleRes, gruppenRes, platzRes]) {
    if (r.error) throw new Error(`RPC fehlgeschlagen: ${r.error.message}`);
  }

  const ziele: ZielLeistung[] = (zieleRes.data ?? []).map((z: any) => ({
    art: z.art === "target" ? "target" : "keyword",
    ziel_id: String(z.ziel_id),
    campaign_id: String(z.campaign_id),
    ad_group_id: String(z.ad_group_id ?? ""),
    text: z.text ?? null,
    match_type: z.match_type ?? null,
    state: z.state ?? null,
    gebot: cents(z.gebot_cents),
    klicks: Number(z.klicks ?? 0),
    bestellungen: Number(z.bestellungen ?? 0),
    umsatz: Number(z.sales_cents ?? 0) / 100,
  }));

  const gruppen: GruppenLeistung[] = (gruppenRes.data ?? []).map((g: any) => ({
    ad_group_id: String(g.ad_group_id ?? ""),
    klicks: Number(g.klicks ?? 0),
    bestellungen: Number(g.bestellungen ?? 0),
    umsatz: Number(g.sales_cents ?? 0) / 100,
  }));

  const anteile = baueAnteile(platzRes.data ?? []);
  const vorschlaege = berechneVorschlaege(ziele, gruppen, anteile, regel);

  return {
    campaign_id: regel.campaign_id,
    regel: {
      ziel_acos: regel.ziel_acos, min_gebot: regel.min_gebot,
      max_gebot: regel.max_gebot, fenster: `${von} bis ${bis}`,
    },
    aufschlag_gewichtet: vorschlaege[0]?.aufschlag_gewichtet ?? 0,
    bilanz: bilanz(vorschlaege),
    vorschlaege,
  };
}

/** Vorschlaege eines Laufs ablegen. */
export async function speichere(
  supabase: any, tenantId: string, laufAm: string, vorschlaege: Vorschlag[],
): Promise<void> {
  if (vorschlaege.length === 0) return;
  const zeilen = vorschlaege.map((v) => ({
    tenant_id: tenantId,
    lauf_am: laufAm,
    campaign_id: v.campaign_id,
    ad_group_id: v.ad_group_id,
    art: v.art,
    ziel_id: v.ziel_id,
    text: v.text,
    match_type: v.match_type,
    gebot_alt_cents: zuCents(v.gebot_alt),
    gebot_neu_cents: zuCents(v.gebot_neu),
    aktion: v.aktion,
    begruendung: v.begruendung,
    klicks: v.klicks,
    bestellungen: v.bestellungen,
    cvr_eigen: v.cvr_eigen,
    cvr_gruppe: v.cvr_gruppe,
    cvr_genutzt: v.cvr_genutzt,
    umsatz_je_best_cents: zuCents(v.umsatz_je_bestellung),
    max_cpc_cents: zuCents(v.max_cpc),
    aufschlag_gewichtet: v.aufschlag_gewichtet,
    belastbar: v.belastbar,
  }));
  // In Haeppchen: eine Kampagne kann einige hundert Ziele haben.
  for (let i = 0; i < zeilen.length; i += 500) {
    const { error } = await supabase
      .from("ads_gebot_vorschlaege")
      .upsert(zeilen.slice(i, i + 500), {
        onConflict: "tenant_id,lauf_am,campaign_id,art,ziel_id",
      });
    if (error) throw new Error(`Speichern fehlgeschlagen: ${error.message}`);
  }
}

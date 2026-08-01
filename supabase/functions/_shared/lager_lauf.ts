// lager_lauf.ts — „Was kostet mein Lager?" je Produkt.
//
// Lagergebühr und Bestandsalter zusammen. Einzeln sagt keins von beidem etwas:
// eine hohe Gebühr bei frischem Bestand ist normal, dieselbe Gebühr bei Ware ab
// dem vierten Monat ist ein Fall fürs Coaching.
//
// Die Beträge stammen aus dem Lagerbericht und sind bereits netto
// (Rate-Card-Werte) — hier wird kein Steuerfaktor angewandt.

export async function lagerKosten(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("lager_kosten", { p_tenant: tenant_id });
  if (error) throw new Error(`lager_kosten: ${error.message}`);

  const zeilen = ((data ?? []) as any[]).map((r) => {
    const basis = Number(r.gebuehr_cents) || 0;
    const alt = Number(r.gebuehr_alt_cents) || 0;
    return {
      asin: r.asin,
      produktname: r.produktname,
      monat: r.monat,
      gebuehr: runde(basis / 100),
      zuschlag: runde((Number(r.zuschlag_cents) || 0) / 100),
      einheiten_frisch: Number(r.frisch) || 0,
      einheiten_alt: Number(r.alt) || 0,
      anteil_alt: r.anteil_alt === null ? null : Math.round(Number(r.anteil_alt) * 1000) / 10,
      gebuehr_ab_monat_4: runde(alt / 100),
      alter_bekannt: Boolean(r.alter_bekannt),
    };
  });

  if (zeilen.length === 0) {
    return {
      zeilen: [], monate: [], summe_gebuehr: null, summe_ab_monat_4: null,
      nicht_bewertbar_grund:
        "Es liegt noch kein Lagerbericht vor. Amazon erstellt ihn monatlich; " +
        "Pulse holt jeweils den letzten abgeschlossenen Monat.",
    };
  }

  const summe = (f: (z: typeof zeilen[number]) => number) =>
    runde(zeilen.reduce((s, z) => s + f(z), 0));

  return {
    zeilen,
    monate: [...new Set(zeilen.map((z) => z.monat).filter(Boolean))].sort(),
    summe_gebuehr: summe((z) => z.gebuehr),
    summe_zuschlag: summe((z) => z.zuschlag),
    summe_ab_monat_4: summe((z) => z.gebuehr_ab_monat_4),
    ohne_altersangabe: zeilen.filter((z) => !z.alter_bekannt).length,
    hinweis: "Lagerung im 1.–3. Monat ist der Preis des Verkaufens. Ab dem 4. Monat " +
      "liegt der Bestand zu lange — dieser Anteil ist selbst erzeugt. Aufgeteilt wird " +
      "nach Menge, weil Amazon die Gebühr nicht je Altersstufe ausweist.",
  };
}

function runde(n: number): number {
  return Math.round(n * 100) / 100;
}

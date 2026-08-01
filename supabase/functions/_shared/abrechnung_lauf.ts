// abrechnung_lauf.ts — Auszahlungen je Abrechnungszeitraum.
//
// Die Frage: Warum ist die Auszahlung kleiner als der Umsatz?
//
// Zwei Zahlen stehen bewusst nebeneinander:
//   * die Summe aller Positionen, die Pulse gelesen hat
//   * die Auszahlung, die Amazon in der Kopfzeile nennt
// Weichen sie ab, wird die Differenz ausgewiesen statt geglättet. Sie zu
// verstecken hiesse, einen Fehler in den Daten als Ergebnis zu verkaufen.

export interface Topf { schluessel: string; label: string; betrag: number }

export async function abrechnungen(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("abrechnungen", { p_tenant: tenant_id });
  if (error) throw new Error(`abrechnungen: ${error.message}`);

  const zeilen = ((data ?? []) as any[]).map((r) => {
    const eur = (x: unknown) => Math.round(Number(x) || 0) / 100;
    const summe = eur(r.summe_positionen_cents);
    const auszahlung = r.auszahlung_cents === null ? null : eur(r.auszahlung_cents);
    // Reihenfolge = Lesereihenfolge des Wasserfalls.
    const toepfe: Topf[] = [
      { schluessel: "umsatz", label: "Umsatz (netto)", betrag: eur(r.umsatz_cents) },
      { schluessel: "versand", label: "Versanderlöse", betrag: eur(r.versand_cents) },
      { schluessel: "steuer", label: "vereinnahmte Umsatzsteuer", betrag: eur(r.steuer_cents) },
      { schluessel: "erstattung", label: "Erstattungen von Amazon", betrag: eur(r.erstattung_cents) },
      { schluessel: "promotion", label: "Rabatte", betrag: eur(r.promotion_cents) },
      { schluessel: "gebuehren", label: "Amazon-Gebühren", betrag: eur(r.gebuehren_cents) },
      { schluessel: "werbung", label: "Werbekosten", betrag: eur(r.werbung_cents) },
      { schluessel: "lager", label: "Lagergebühren", betrag: eur(r.lager_cents) },
      { schluessel: "sonstiges", label: "Sonstiges (Anlieferung, Reserve, Abos)", betrag: eur(r.sonstiges_cents) },
    ].filter((t) => t.betrag !== 0);

    return {
      settlement_id: r.settlement_id,
      von: r.von, bis: r.bis, auszahlung_datum: r.auszahlung_datum,
      toepfe, summe, auszahlung,
      // Positiv: Pulse rechnet mehr als Amazon auszahlt.
      differenz: auszahlung === null ? null : Math.round((summe - auszahlung) * 100) / 100,
      positionen: Number(r.positionen) || 0,
    };
  });

  if (zeilen.length === 0) {
    return {
      zeilen: [], hat_werbung: false,
      nicht_bewertbar_grund:
        "Es liegt noch kein Abrechnungsbericht vor. Amazon erzeugt ihn je Auszahlung; " +
        "Pulse holt jeweils den jüngsten.",
    };
  }

  const werbung = zeilen.reduce(
    (s, z) => s + (z.toepfe.find((t) => t.schluessel === "werbung")?.betrag ?? 0), 0);

  return {
    zeilen,
    // Wichtig fuer die Produktrechnung: Werbekosten stehen hier, auch wenn die
    // Ads-API gesperrt ist. Allerdings NICHT je ASIN — nur als Gesamtbetrag.
    hat_werbung: werbung !== 0,
    werbung_gesamt: Math.round(werbung * 100) / 100,
    hinweis: "Die Auszahlung ist der Umsatz minus alles, was Amazon einbehält. " +
      "Weicht die Summe der Positionen von der genannten Auszahlung ab, steht die " +
      "Differenz da — sie wird nicht weggerechnet.",
  };
}

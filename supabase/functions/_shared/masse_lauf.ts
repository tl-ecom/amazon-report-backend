// masse_lauf.ts — Maße, Gewicht und Volumengewicht je SKU.
//
// Die Frage, die diese Ansicht beantwortet: WONACH wird abgerechnet?
//
// Für Pakete nimmt Amazon den GRÖSSEREN Wert aus Stückgewicht und
// Volumengewicht (L×B×H/5000). Wo das Volumen gewinnt, senkt eine flachere
// Verpackung die Gebühr — eine leichtere nicht. Das ist ein anderer Hebel, und
// ohne diese Ansicht sieht man ihn nicht.
//
// Für Umschläge und den Niedrigpreisversand zählt NUR das Stückgewicht
// (Rate Card S. 6, Fussnote 4). Dort wird das Volumengewicht deshalb nicht als
// „entscheidend" markiert, auch wenn es rechnerisch größer ist.

const LAND: Record<string, string> = {
  A1PA6795UKMFR9: "DE", A13V1IB3VIYZZH: "FR", APJ6JRA9NG5V4: "IT",
  A1RKKUPIHCS9HS: "ES", A1F83G8C2ARO7P: "UK", A1805IZSGTT6HS: "NL",
  A2NODRKZP88ZB9: "SE", A1C3SOZRARQ6R3: "PL", AMEN7PMS3EDWL: "BE",
  A28R8C7NBKEWEA: "IE",
};

/** Zählt für diese Größenklasse das Volumengewicht überhaupt? */
export function volumenZaehlt(groessenklasse: string | null): boolean {
  if (!groessenklasse) return false;
  return /parcel|paket|oversize|übergröße|uebergroesse/i.test(groessenklasse);
}

export async function masseUebersicht(supabase: any, tenant_id: string): Promise<unknown> {
  const { data: ctx } = await supabase.from("auth_contexts")
    .select("marketplace_id").eq("tenant_id", tenant_id).limit(1).maybeSingle();
  const markt = LAND[String(ctx?.marketplace_id ?? "")] ?? null;
  if (!markt) return leer("Der Marktplatz dieser Firma ist nicht bekannt.");

  const { data, error } = await supabase.from("fba_gebuehrenvorschau")
    .select("sku, asin, produktname, groessenklasse, laengste_seite_cm, mittlere_seite_cm, " +
      "kuerzeste_seite_cm, gewicht_g, volumengewicht_g, versandgewicht_g, fulfilment_cents")
    .eq("tenant_id", tenant_id).eq("marketplace", markt);
  if (error) throw new Error(`fba_gebuehrenvorschau: ${error.message}`);

  const zeilen = ((data ?? []) as any[]).map((r) => {
    const stueck = zahl(r.gewicht_g);
    const volumen = zahl(r.volumengewicht_g);
    const zaehlt = volumenZaehlt(r.groessenklasse);
    // „Volumen entscheidet" nur, wo es laut Tarif ueberhaupt zaehlt UND groesser ist.
    const volumenEntscheidet = zaehlt && stueck !== null && volumen !== null && volumen > stueck;
    return {
      sku: r.sku,
      asin: r.asin ?? null,
      produktname: r.produktname ?? null,
      groessenklasse: r.groessenklasse ?? null,
      laengste_cm: zahl(r.laengste_seite_cm),
      mittlere_cm: zahl(r.mittlere_seite_cm),
      kuerzeste_cm: zahl(r.kuerzeste_seite_cm),
      stueckgewicht_g: stueck,
      volumengewicht_g: volumen === null ? null : Math.round(volumen),
      // Wonach abgerechnet wird — bei Umschlaegen immer das Stueckgewicht.
      abrechnungsgewicht_g: zaehlt
        ? (stueck !== null && volumen !== null ? Math.round(Math.max(stueck, volumen)) : null)
        : (stueck === null ? null : Math.round(stueck)),
      volumen_zaehlt: zaehlt,
      volumen_entscheidet: volumenEntscheidet,
      // Wieviel Luft: um so viel liegt das Volumengewicht ueber dem echten.
      aufschlag_g: volumenEntscheidet && stueck !== null && volumen !== null
        ? Math.round(volumen - stueck) : null,
      gebuehr: r.fulfilment_cents === null ? null : Math.round(Number(r.fulfilment_cents)) / 100,
    };
  });

  if (zeilen.length === 0) {
    return leer("Der Gebührenvorschau-Report liegt noch nicht vor — ohne ihn kennt Pulse keine Maße.");
  }

  const pakete = zeilen.filter((z) => z.volumen_zaehlt);
  const nachVolumen = zeilen.filter((z) => z.volumen_entscheidet);
  return {
    marktplatz: markt,
    zeilen: zeilen.sort((a, b) => (b.aufschlag_g ?? -1) - (a.aufschlag_g ?? -1)),
    produkte: zeilen.length,
    pakete: pakete.length,
    volumen_entscheidet: nachVolumen.length,
    hinweis: "Bei Paketen rechnet Amazon mit dem größeren Wert aus Stück- und Volumengewicht " +
      "(Länge × Breite × Höhe ÷ 5000). Wo das Volumen gewinnt, hilft eine flachere Verpackung — " +
      "eine leichtere nicht. Umschläge werden immer nach Stückgewicht abgerechnet.",
  };
}

function zahl(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function leer(grund: string) {
  return {
    marktplatz: null, zeilen: [], produkte: 0, pakete: 0,
    volumen_entscheidet: 0, hinweis: null, nicht_bewertbar_grund: grund,
  };
}

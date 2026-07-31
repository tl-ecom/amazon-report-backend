// abgleich_lauf.ts — DB-Schicht für Modul 3 (Soll-Ist-Abgleich der Maße).
// Die Vergleichsregeln liegen rein und getestet in masse_abgleich.ts.
//
// Die Soll-Gebühr ist der heikle Teil: Was würde Amazon abrechnen, wenn die
// Katalogmaße stimmten? Dafür wird aus den Katalogmaßen die passende Klasse
// bestimmt und deren Gebühr genommen — innerhalb derselben Tarifart wie die
// tatsächlich zugewiesene Klasse. Lässt sich das nicht bestimmen, bleibt die
// Soll-Gebühr null und der Befund ist Datenpflege, kein Kostenfall.

import { klasseFuerMasse, type Klasse } from "./groessenklassen.ts";
import { abgleichReport, type Paar } from "./masse_abgleich.ts";
import { baueKlassen } from "./korridor_lauf.ts";

const LAND: Record<string, string> = {
  A1PA6795UKMFR9: "DE", A13V1IB3VIYZZH: "FR", APJ6JRA9NG5V4: "IT",
  A1RKKUPIHCS9HS: "ES", A1F83G8C2ARO7P: "UK", A1805IZSGTT6HS: "NL",
  A2NODRKZP88ZB9: "SE", A1C3SOZRARQ6R3: "PL", AMEN7PMS3EDWL: "BE",
  A28R8C7NBKEWEA: "IE",
};

export async function masseAbgleich(
  supabase: any, tenant_id: string, opts?: { tage?: unknown },
): Promise<unknown> {
  const tage = Number(opts?.tage) > 0 ? Math.min(Number(opts?.tage), 730) : 365;

  const { data: ctx } = await supabase.from("auth_contexts")
    .select("marketplace_id").eq("tenant_id", tenant_id).limit(1).maybeSingle();
  const markt = LAND[String(ctx?.marketplace_id ?? "")] ?? null;
  if (!markt) return leer("Der Marktplatz dieser Firma ist nicht bekannt.");

  const [katalogRes, produkteRes, scheduleRes] = await Promise.all([
    supabase.from("katalog_masse").select("*").eq("tenant_id", tenant_id).eq("marketplace", markt),
    supabase.rpc("korridor_produkte", { p_tenant: tenant_id, p_markt: markt, p_tage: tage }),
    supabase.from("fee_schedule").select("*").eq("marketplace", markt)
      .lte("gueltig_ab", new Date().toISOString().slice(0, 10))
      .order("gueltig_ab", { ascending: false }),
  ]);
  if (produkteRes.error) throw new Error(`korridor_produkte: ${produkteRes.error.message}`);

  const katalog = new Map<string, any>(
    ((katalogRes.data ?? []) as any[]).map((k) => [String(k.asin), k]),
  );
  if (katalog.size === 0) {
    return leer(
      "Es sind noch keine Katalogmaße abgeholt. Sie kommen aus der Catalog-Items-API und " +
      "sind die Gegenprobe zu dem, was Amazon misst — ohne sie gibt es nichts zu vergleichen.",
    );
  }

  const zeilen = (scheduleRes.data ?? []) as any[];
  const klassen: Klasse[] = zeilen.length
    ? baueKlassen(zeilen.filter((z) => z.gueltig_ab === zeilen[0].gueltig_ab))
    : [];

  const paare: Paar[] = [];
  for (const r of (produkteRes.data ?? []) as any[]) {
    const asin = r.asin ? String(r.asin) : null;
    if (!asin) continue;
    const k = katalog.get(asin);

    const gemessen = {
      laengste_cm: zahl(r.laengste_seite_cm),
      mittlere_cm: zahl(r.mittlere_seite_cm),
      kuerzeste_cm: zahl(r.kuerzeste_seite_cm),
      gewicht_g: zahl(r.gewicht_g),
    };
    const kat = {
      laenge_cm: zahl(k?.laenge_cm), breite_cm: zahl(k?.breite_cm),
      hoehe_cm: zahl(k?.hoehe_cm), gewicht_g: zahl(k?.gewicht_g),
    };

    // BEIDE Seiten aus derselben Tabelle rechnen.
    //
    // Naheliegend wäre, Amazons gemessene Gebühr gegen eine aus der Tabelle
    // gerechnete Soll-Gebühr zu stellen. Das mischt aber zwei Quellen: Amazons
    // Wert enthält den Treibstoffaufschlag von 1,5 % und folgt beim
    // Niedrigpreisversand einem ganz anderen Tarif. Die Differenz wäre dann
    // teils Steuerung, teils Messfehler — und niemand könnte sie trennen.
    //
    // Tabelle gegen Tabelle ist sauber: Der Unterschied kommt ausschliesslich
    // aus den Massen. Die tatsächlich erwartete Gebühr steht daneben.
    const aktuelleKlasse = klassen.find((x) => x.size_tier === r.groessenklasse);
    let istCents: number | null = null;
    let sollCents: number | null = null;

    if (klassen.length > 0 && aktuelleKlasse
      && gemessen.laengste_cm !== null && gemessen.mittlere_cm !== null
      && gemessen.kuerzeste_cm !== null && gemessen.gewicht_g !== null) {
      const ist = klasseFuerMasse(
        [gemessen.laengste_cm, gemessen.mittlere_cm, gemessen.kuerzeste_cm],
        gemessen.gewicht_g, [aktuelleKlasse], aktuelleKlasse,
      );
      if (ist) istCents = Math.round(ist.gebuehr * 100);
    }

    if (istCents !== null && kat.laenge_cm !== null && kat.breite_cm !== null && kat.hoehe_cm !== null) {
      // Ohne Katalog-Gewicht das gemessene nehmen: Es geht hier um die Maße,
      // und ein fehlendes Gewicht darf den Massvergleich nicht unmöglich machen.
      const gewicht = kat.gewicht_g ?? gemessen.gewicht_g ?? 0;
      const treffer = klasseFuerMasse(
        [kat.laenge_cm, kat.breite_cm, kat.hoehe_cm], gewicht, klassen, aktuelleKlasse,
      );
      if (treffer) sollCents = Math.round(treffer.gebuehr * 100);
    }

    paare.push({
      asin,
      sku: r.sku ? String(r.sku) : null,
      produktname: r.produktname ?? null,
      katalog: kat,
      gemessen,
      gebuehr_cents: istCents,
      gebuehr_soll_cents: sollCents,
      einheiten: Number(r.einheiten) || 0,
    });
  }

  if (paare.length === 0) {
    return leer("Der Gebührenvorschau-Report liegt noch nicht vor — ohne ihn fehlen die gemessenen Maße.");
  }

  return {
    marktplatz: markt,
    fenster_tage: tage,
    katalog_abgeholt: katalog.size,
    produkte_geprueft: paare.length,
    klassen_hinterlegt: klassen.length,
    ...abgleichReport(paare),
    hebel: "operations",
  };
}

function zahl(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function leer(grund: string) {
  return {
    marktplatz: null, fenster_tage: null, katalog_abgeholt: 0,
    produkte_geprueft: 0, klassen_hinterlegt: 0,
    befunde: [], kosten: [], pflege: [], summe_mehrkosten: null,
    stimmig: 0, nicht_bewertbar: 0,
    hinweis: null, hebel: "operations",
    nicht_bewertbar_grund: grund,
  };
}

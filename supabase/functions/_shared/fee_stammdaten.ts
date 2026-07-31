// fee_stammdaten.ts — DB-Schicht für die Gebühren-Stammdaten (Fee Decoder).
//
// Zwei Tabellen, beide plattformweit (nicht je Firma):
//   * fee_schedule            — Amazons Größenklassen-Grenzen + Gebühr, versioniert
//   * fee_type_classification — Gebührentyp -> steuerbar? -> Hebel + Maßnahme
//
// Beides pflegt NUR der Plattform-Admin. Reine Parserlogik: fee_schedule_csv.ts.
//
// Grundsatz: Was hier nicht gepflegt ist, wird als „nicht bewertbar" ausgewiesen —
// niemals durch geschätzte Werte ersetzt.

import { istPlattformAdmin } from "./admin.ts";
import { parseGebuehrenCsv } from "./fee_schedule_csv.ts";

export interface SchedulImportErgebnis {
  erkannt: Record<string, string | null>;
  spalten: string[];
  gelesen: number;
  uebersprungen: number;
  geschrieben: number;
  warnungen: string[];
  vorschau: boolean;
}

/** Gebührentabelle importieren. `schreiben=false` liefert dieselbe Vorschau ohne Wirkung. */
export async function importiereFeeSchedule(
  supabase: any, callerId: string, csv: string, gueltigAb: string, schreiben: boolean,
): Promise<SchedulImportErgebnis> {
  if (!(await istPlattformAdmin(supabase, callerId))) throw new Error("nicht autorisiert");
  const ab = /^\d{4}-\d{2}-\d{2}$/.test(gueltigAb ?? "") ? gueltigAb : null;
  if (!ab) throw new Error("Bitte ein Gültigkeitsdatum im Format JJJJ-MM-TT angeben.");

  const p = parseGebuehrenCsv(csv, ab);
  const erg: SchedulImportErgebnis = {
    erkannt: p.erkannt, spalten: p.spalten, gelesen: p.zeilen.length,
    uebersprungen: p.uebersprungen, geschrieben: 0,
    warnungen: [...p.warnungen], vorschau: !schreiben,
  };
  if (!schreiben || p.zeilen.length === 0) return erg;

  const { error } = await supabase.from("fee_schedule").upsert(
    p.zeilen.map((z) => ({ ...z, quelle: "csv-import", updated_at: new Date().toISOString() })),
    { onConflict: "marketplace,size_tier,gueltig_ab" },
  );
  if (error) throw new Error(`fee_schedule schreiben: ${error.message}`);
  erg.geschrieben = p.zeilen.length;
  return erg;
}

/** Gepflegte Gebührentabelle lesen (Admin-Ansicht). */
export async function listeFeeSchedule(supabase: any, callerId: string): Promise<unknown> {
  if (!(await istPlattformAdmin(supabase, callerId))) throw new Error("nicht autorisiert");
  const { data, error } = await supabase.from("fee_schedule")
    .select("*").order("marketplace").order("gueltig_ab", { ascending: false }).order("size_tier");
  if (error) throw new Error(`fee_schedule lesen: ${error.message}`);
  return { zeilen: data ?? [] };
}

/**
 * Klassifizierung + offene Punkte. „Offen" heißt: Der Gebührentyp taucht real in
 * den Finanzdaten auf, ist aber noch nicht als steuerbar/nicht steuerbar
 * eingeordnet. Solche Typen fließen in KEINE Bewertung ein — sie werden dem Admin
 * gemeldet, statt still zu verschwinden.
 */
export async function listeFeeKlassifizierung(supabase: any, callerId: string): Promise<unknown> {
  if (!(await istPlattformAdmin(supabase, callerId))) throw new Error("nicht autorisiert");
  const [klass, hebel, gesehen] = await Promise.all([
    supabase.from("fee_type_classification").select("*").order("fee_typ"),
    supabase.from("fee_hebel").select("*").order("sortierung"),
    supabase.rpc("fee_typen_gesehen"),
  ]);
  if (klass.error) throw new Error(`Klassifizierung lesen: ${klass.error.message}`);
  const bekannt = new Map<string, any>((klass.data ?? []).map((r: any) => [r.fee_typ, r]));

  const offen: Array<{ fee_typ: string; summe_cents: number; firmen: number; grund: string }> = [];
  for (const g of (gesehen.data ?? []) as any[]) {
    const k = bekannt.get(g.fee_typ);
    if (!k) {
      offen.push({ ...g, grund: "unbekannter Gebührentyp — noch nicht in der Klassifizierung" });
    } else if (k.steuerbar === null) {
      offen.push({ ...g, grund: "erfasst, aber noch nicht als steuerbar/nicht steuerbar eingeordnet" });
    }
  }
  return { klassifizierung: klass.data ?? [], hebel: hebel.data ?? [], offen };
}

/** Einen Gebührentyp einordnen (Admin). Hebel muss aus der geschlossenen Liste stammen. */
export async function setzeFeeKlassifizierung(
  supabase: any, callerId: string, eingabe: Record<string, unknown>,
): Promise<{ ok: true }> {
  if (!(await istPlattformAdmin(supabase, callerId))) throw new Error("nicht autorisiert");
  const typ = String(eingabe?.fee_typ ?? "").trim();
  if (!typ) throw new Error("fee_typ fehlt");

  const hebelRaw = eingabe?.hebel;
  const steuerbar = eingabe?.steuerbar === null || eingabe?.steuerbar === undefined
    ? null
    : Boolean(eingabe.steuerbar);
  // Ein steuerbarer Typ ohne Hebel waere im Coaching-Modell nicht einzuordnen.
  if (steuerbar === true && !hebelRaw) throw new Error("Ein steuerbarer Gebührentyp braucht einen Hebel.");

  const { error } = await supabase.from("fee_type_classification").upsert({
    fee_typ: typ,
    label: eingabe?.label ? String(eingabe.label).slice(0, 200) : null,
    steuerbar,
    hebel: hebelRaw ? String(hebelRaw) : null,
    hebel_alternativ: eingabe?.hebel_alternativ ? String(eingabe.hebel_alternativ) : null,
    massnahme: eingabe?.massnahme ? String(eingabe.massnahme).slice(0, 1000) : null,
    hinweis: eingabe?.hinweis ? String(eingabe.hinweis).slice(0, 500) : null,
    quelle: "admin",
    updated_at: new Date().toISOString(),
  }, { onConflict: "fee_typ" });
  // Verstoss gegen den Fremdschluessel = Hebel ausserhalb der geschlossenen Fuenferliste.
  if (error) {
    if (/foreign key|fee_hebel/i.test(error.message)) {
      throw new Error("Unbekannter Hebel — erlaubt sind nur die fünf Hebel des Coaching-Modells.");
    }
    throw new Error(`Klassifizierung speichern: ${error.message}`);
  }
  return { ok: true };
}

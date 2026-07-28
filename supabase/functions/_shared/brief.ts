// brief.ts — Weekly Coaching Brief (§16). Bündelt den aktuellen Stand zu einem
// eingefrorenen Wochenschnappschuss: KPIs (mit ihrem ECHTEN Report-Zeitraum, nicht
// als "diese Woche" verkauft), offene Diagnosen, Aufgaben-Status und die Änderungen
// der letzten 7 Tage.
//
// fasseBriefZusammen(...) ist rein und unit-getestet (nimmt bereits geladene Daten).
// generiereBrief(...) sammelt + persistiert.

import { pulseOverview } from "./overview.ts";

const PRIO_RANG: Record<string, number> = { kritisch: 0, hoch: 1, mittel: 2, niedrig: 3 };

interface DiagnoseRow { typ: string; asin: string | null; prioritaet: string; status: string; beobachtung: string }
interface TaskRow { titel: string; prioritaet: string; status: string; asin: string | null; erledigt_am: string | null }
interface ChangeRow { asin: string | null; event_type: string; previous_value: string | null; new_value: string | null; relevance: string | null; effective_at: string | null }

/** Baut den Brief-Inhalt aus bereits geladenen Daten. Rein & deterministisch. */
export function fasseBriefZusammen(
  overview: any,
  diagnosen: DiagnoseRow[],
  tasks: TaskRow[],
  changes: ChangeRow[],
  vonISO: string,
): Record<string, unknown> {
  // Diagnosen: nur offene zählen/zeigen.
  const offeneDiag = (diagnosen ?? []).filter((d) => d.status === "offen");
  const nachPrio = { kritisch: 0, hoch: 0, mittel: 0, niedrig: 0 } as Record<string, number>;
  for (const d of offeneDiag) if (d.prioritaet in nachPrio) nachPrio[d.prioritaet]++;
  const topDiag = offeneDiag
    .slice()
    .sort((a, b) => (PRIO_RANG[a.prioritaet] ?? 9) - (PRIO_RANG[b.prioritaet] ?? 9))
    .slice(0, 3)
    .map((d) => ({ typ: d.typ, asin: d.asin, prioritaet: d.prioritaet, beobachtung: d.beobachtung }));

  // Aufgaben: aktive (offen/in_arbeit) + in den letzten 7 Tagen erledigte.
  const aktiv = (tasks ?? []).filter((t) => t.status === "offen" || t.status === "in_arbeit");
  const offen = (tasks ?? []).filter((t) => t.status === "offen").length;
  const inArbeit = (tasks ?? []).filter((t) => t.status === "in_arbeit").length;
  const erledigt7t = (tasks ?? []).filter((t) => t.status === "erledigt" && t.erledigt_am != null && t.erledigt_am >= vonISO).length;
  const topOffen = aktiv
    .slice()
    .sort((a, b) => (PRIO_RANG[a.prioritaet] ?? 9) - (PRIO_RANG[b.prioritaet] ?? 9))
    .slice(0, 5)
    .map((t) => ({ titel: t.titel, prioritaet: t.prioritaet, asin: t.asin, status: t.status }));

  return {
    erstellt_am: new Date().toISOString(),
    ampel: overview?.status ?? null,
    kpis: {
      // Bewusst MIT dem echten Report-Zeitraum — nicht als Brief-Woche ausgegeben.
      zeitraum: overview?.zeitraum ?? null,
      is_provisional: overview?.is_provisional ?? false,
      umsatz: overview?.kpis?.umsatz ?? null,
      waehrung: overview?.kpis?.waehrung ?? null,
      sessions: overview?.kpis?.sessions ?? null,
      unitsOrdered: overview?.kpis?.unitsOrdered ?? null,
      cvr: overview?.kpis?.cvr ?? null,
      retourenquote: overview?.kpis?.retourenquote ?? null,
    },
    diagnosen: { offen_gesamt: offeneDiag.length, nach_prio: nachPrio, top: topDiag },
    aufgaben: { offen, in_arbeit: inArbeit, erledigt_letzte_7t: erledigt7t, top_offen: topOffen },
    aenderungen_7t: (changes ?? []).slice(0, 10).map((c) => ({
      asin: c.asin, event_type: c.event_type, previous_value: c.previous_value,
      new_value: c.new_value, relevance: c.relevance, effective_at: c.effective_at,
    })),
  };
}

/** Sammelt den aktuellen Stand und speichert ihn als Brief (ein Stichtag je Firma). */
export async function generiereBrief(supabase: any, tenant_id: string, userId: string): Promise<unknown> {
  const jetzt = new Date();
  const von = new Date(jetzt.getTime() - 7 * 86400000);
  const vonISO = von.toISOString();
  const zeitraum_von = vonISO.slice(0, 10);
  const zeitraum_bis = jetzt.toISOString().slice(0, 10);

  const [overview, diagRes, taskRes, changeRes] = await Promise.all([
    pulseOverview(supabase, tenant_id) as Promise<any>,
    supabase.from("diagnoses").select("typ, asin, prioritaet, status, beobachtung").eq("tenant_id", tenant_id),
    supabase.from("tasks").select("titel, prioritaet, status, asin, erledigt_am").eq("tenant_id", tenant_id),
    supabase.from("change_events").select("asin, event_type, previous_value, new_value, relevance, effective_at")
      .eq("tenant_id", tenant_id).gte("effective_at", vonISO).order("effective_at", { ascending: false }),
  ]);

  const inhalt = fasseBriefZusammen(overview, diagRes.data ?? [], taskRes.data ?? [], changeRes.data ?? [], vonISO);

  const { data, error } = await supabase.from("weekly_briefs").upsert({
    tenant_id, zeitraum_von, zeitraum_bis, inhalt, erstellt_von: userId, updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,zeitraum_bis" }).select().single();
  if (error) throw new Error(`weekly_briefs upsert: ${error.message}`);
  return { brief: data };
}

/** Briefs einer Firma (neueste zuerst). */
export async function listeBriefs(supabase: any, tenant_id: string): Promise<unknown> {
  const { data, error } = await supabase.from("weekly_briefs")
    .select("id, zeitraum_von, zeitraum_bis, inhalt, coach_notiz, created_at, updated_at")
    .eq("tenant_id", tenant_id).order("zeitraum_bis", { ascending: false });
  if (error) throw new Error(`weekly_briefs read: ${error.message}`);
  return { briefs: data ?? [] };
}

/** Coach-Notiz an einem Brief setzen/ändern. */
export async function setzeCoachNotiz(supabase: any, tenant_id: string, id: string, notiz: string): Promise<{ ok: true }> {
  if (!id) throw new Error("id fehlt");
  const { error } = await supabase.from("weekly_briefs")
    .update({ coach_notiz: notiz?.trim() || null, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenant_id).eq("id", id);
  if (error) throw new Error(`weekly_briefs notiz: ${error.message}`);
  return { ok: true };
}

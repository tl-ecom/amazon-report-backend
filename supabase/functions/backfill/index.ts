// backfill — Orchestrator für den historischen Import (24 Monate).
//
// Verarbeitet pro Aufruf GENAU EINEN Chunk aus public.backfill_jobs und ruft
// dafür sync-report auf (mit end_date + history_only=true). Getrieben wird der
// Ablauf von außen (pg_cron alle paar Minuten) — so bleiben die Amazon-Rate-Limits
// eingehalten und der Import überlebt das Ende einer Chat-Session.
//
// Ein Chunk = ein Zeitfenster eines Report-Typs. Zustände in backfill_jobs.status:
//   pending -> running (+report_id in detail, falls Amazon noch rechnet) -> done
//   CANCELLED (kein Datenbestand im Fenster) zählt als done.
//   FATAL/echte Fehler -> error (wird NICHT automatisch wiederholt; manuell prüfen).
//
// Wählt bewusst die NEUESTEN Fenster zuerst (bis desc) — aktuelle Historie ist
// am nützlichsten und wird zuerst verfügbar.

import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function tageZwischen(von: string, bis: string): number {
  const d = Math.round((new Date(bis).getTime() - new Date(von).getTime()) / 86_400_000);
  return Math.max(1, d);
}

Deno.serve(async (req) => {
  const supabase = createClient(URL, KEY);
  const body = await req.json().catch(() => ({}));
  const tenant_id: string | undefined = body.tenant_id;
  if (!tenant_id) return json({ error: "tenant_id fehlt" }, 400);

  // 1) Zuerst einen laufenden Chunk fortsetzen, dessen Amazon-Report noch rechnet
  //    (detail = report_id). Sonst den nächsten offenen (neueste zuerst).
  const { data: laufend } = await supabase
    .from("backfill_jobs")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("status", "running")
    .not("detail", "is", null)
    .order("bis", { ascending: false })
    .limit(1)
    .maybeSingle();

  let chunk = laufend;
  let resume = Boolean(laufend?.detail);

  if (!chunk) {
    const { data: pending } = await supabase
      .from("backfill_jobs")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("status", "pending")
      .order("bis", { ascending: false })
      .limit(1)
      .maybeSingle();
    chunk = pending;
    resume = false;
  }

  if (!chunk) {
    return json({ ok: true, done: true, hinweis: "Keine offenen Chunks mehr." });
  }

  // Chunk als laufend markieren (bei resume bleibt detail = report_id erhalten).
  await supabase
    .from("backfill_jobs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", chunk.id);

  const spBody = resume
    ? { tenant_id, report_id: chunk.detail }
    : {
        tenant_id,
        report_type: chunk.report_type,
        days: tageZwischen(chunk.von, chunk.bis),
        end_date: chunk.bis,
        history_only: true,
      };

  let data: any;
  try {
    const resp = await fetch(`${URL}/functions/v1/sync-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(spBody),
    });
    data = await resp.json();
  } catch (e) {
    await setze(supabase, chunk.id, "pending", `Aufruf fehlgeschlagen: ${String(e)}`.slice(0, 500));
    return json({ ok: false, chunk: kurz(chunk), ergebnis: "retry", detail: String(e) });
  }

  const info = { report_type: chunk.report_type, von: chunk.von, bis: chunk.bis };

  if (data?.status === "DONE") {
    await setze(supabase, chunk.id, "done", null);
    return json({ ok: true, chunk: info, ergebnis: "done", verlauf: data.verlauf });
  }
  if (data?.status === "PROCESSING") {
    // Amazon rechnet noch — report_id merken, nächster Tick nimmt ihn wieder auf.
    await setze(supabase, chunk.id, "running", String(data.report_id ?? "").slice(0, 200) || null);
    return json({ ok: true, chunk: info, ergebnis: "processing", report_id: data.report_id });
  }
  if (data?.status === "CANCELLED") {
    // Report storniert = meist keine Daten im Fenster. Nichts zu importieren.
    await setze(supabase, chunk.id, "done", "CANCELLED (keine Daten im Fenster)");
    return json({ ok: true, chunk: info, ergebnis: "cancelled_done" });
  }

  // FATAL oder echter Fehler (z. B. Fenster jenseits der Amazon-Aufbewahrung).
  await setze(
    supabase,
    chunk.id,
    "error",
    String(data?.error ?? data?.status ?? "unbekannter Fehler").slice(0, 500)
  );
  return json({ ok: false, chunk: info, ergebnis: "error", detail: data });
});

async function setze(supabase: any, id: string, status: string, detail: string | null): Promise<void> {
  await supabase
    .from("backfill_jobs")
    .update({ status, detail, updated_at: new Date().toISOString() })
    .eq("id", id);
}

function kurz(c: any) {
  return { report_type: c.report_type, von: c.von, bis: c.bis };
}

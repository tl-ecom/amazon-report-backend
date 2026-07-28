import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { erstelleTask, setzeTaskStatus, taskAusDiagnose } from "./tasks.ts";

// Query-Stub: jede from()-Nutzung zieht die nächste vorbereitete Antwort; insert/
// update-Zeilen werden mitgeschrieben. Der Builder ist thenable -> await auf die
// Kette liefert die Antwort.
function client(responses: Array<{ data?: unknown; error?: unknown }>) {
  const calls = { inserts: [] as any[], updates: [] as any[] };
  let i = 0;
  const api = {
    from(_table: string) {
      const r = responses[i++] ?? { data: null, error: null };
      const b: any = {
        select: () => b,
        eq: () => b,
        in: () => b,
        maybeSingle: () => b,
        single: () => b,
        insert: (row: any) => { calls.inserts.push(row); return b; },
        update: (row: any) => { calls.updates.push(row); return b; },
        then: (res: any) => Promise.resolve(r).then(res),
      };
      return b;
    },
  } as any;
  return { client: api, calls };
}

Deno.test("erstelleTask: leerer Titel wirft", async () => {
  await assertRejects(() => erstelleTask(client([]).client, "t", "u", { titel: "  " }) as any, Error, "Titel");
});

Deno.test("erstelleTask: Defaults (mittel/manuell) + tenant/ersteller gesetzt", async () => {
  const c = client([{ data: { id: "x" }, error: null }]);
  await erstelleTask(c.client, "tenant1", "user1", { titel: "Preis prüfen" });
  assertEquals(c.calls.inserts[0].prioritaet, "mittel");
  assertEquals(c.calls.inserts[0].quelle, "manuell");
  assertEquals(c.calls.inserts[0].tenant_id, "tenant1");
  assertEquals(c.calls.inserts[0].erstellt_von, "user1");
});

Deno.test("erstelleTask: ungültige Priorität fällt auf mittel zurück", async () => {
  const c = client([{ data: { id: "x" }, error: null }]);
  await erstelleTask(c.client, "t", "u", { titel: "x", prioritaet: "bogus" });
  assertEquals(c.calls.inserts[0].prioritaet, "mittel");
});

Deno.test("setzeTaskStatus: ungültiger Status wirft", async () => {
  await assertRejects(() => setzeTaskStatus(client([]).client, "t", "id", "bogus"), Error, "ungültiger Status");
});

Deno.test("setzeTaskStatus: erledigt stempelt erledigt_am", async () => {
  const c = client([{ data: null, error: null }]);
  await setzeTaskStatus(c.client, "t", "id", "erledigt");
  assertEquals(c.calls.updates[0].status, "erledigt");
  assert(c.calls.updates[0].erledigt_am !== null);
});

Deno.test("setzeTaskStatus: reopen löscht erledigt_am", async () => {
  const c = client([{ data: null, error: null }]);
  await setzeTaskStatus(c.client, "t", "id", "offen");
  assertEquals(c.calls.updates[0].erledigt_am, null);
});

Deno.test("taskAusDiagnose: leere id wirft", async () => {
  await assertRejects(() => taskAusDiagnose(client([]).client, "t", "u", "") as any, Error, "diagnose_id");
});

Deno.test("taskAusDiagnose: vorhandene aktive Aufgabe -> kein Insert", async () => {
  const c = client([{ data: { id: "t1", titel: "x", status: "offen" }, error: null }]);
  const r = await taskAusDiagnose(c.client, "t", "u", "dID") as any;
  assertEquals(r.bereits_vorhanden, true);
  assertEquals(c.calls.inserts.length, 0);
});

Deno.test("taskAusDiagnose: baut Titel aus Typ + ASIN, übernimmt Priorität", async () => {
  const c = client([
    { data: null, error: null }, // keine vorhandene Aufgabe
    { data: { typ: "traffic_ohne_verkauf", asin: "B01", beobachtung: "o", begruendung: "b", prioritaet: "hoch" }, error: null },
    { data: { id: "neu" }, error: null }, // insert
  ]);
  await taskAusDiagnose(c.client, "t", "u", "dID");
  assertEquals(c.calls.inserts[0].titel, "Traffic ohne Verkauf prüfen — B01");
  assertEquals(c.calls.inserts[0].prioritaet, "hoch");
  assertEquals(c.calls.inserts[0].quelle, "diagnose");
  assertEquals(c.calls.inserts[0].diagnose_id, "dID");
});

Deno.test("taskAusDiagnose: unbekannte Diagnose wirft", async () => {
  const c = client([{ data: null, error: null }, { data: null, error: null }]);
  await assertRejects(() => taskAusDiagnose(c.client, "t", "u", "dID") as any, Error, "nicht gefunden");
});

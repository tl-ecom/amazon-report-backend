import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { erstelleNote, listeNotes, setzeNoteSichtbarkeit } from "./notes.ts";

// Chainable Query-Stub: erfasst eq-Filter + insert/update; thenable liefert Antwort.
function client(result: { data?: unknown; error?: unknown }) {
  const calls = { eqs: [] as Array<[string, unknown]>, inserts: [] as any[], updates: [] as any[] };
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => { calls.eqs.push([k, v]); return b; },
    order: () => b,
    insert: (row: any) => { calls.inserts.push(row); return b; },
    update: (row: any) => { calls.updates.push(row); return b; },
    single: () => b,
    then: (res: any) => Promise.resolve(result).then(res),
  };
  return { client: { from: () => b } as any, calls };
}

Deno.test("listeNotes als Coach: kein sichtbarkeit-Filter, als_coach=true", async () => {
  const c = client({ data: [{ id: "1", sichtbarkeit: "intern" }], error: null });
  const r = await listeNotes(c.client, "t", true) as any;
  assertEquals(r.als_coach, true);
  assertEquals(c.calls.eqs.some(([k]) => k === "sichtbarkeit"), false);
});

Deno.test("listeNotes als Coachee: erzwingt sichtbarkeit='coachee'", async () => {
  const c = client({ data: [], error: null });
  const r = await listeNotes(c.client, "t", false) as any;
  assertEquals(r.als_coach, false);
  assert(c.calls.eqs.some(([k, v]) => k === "sichtbarkeit" && v === "coachee"));
});

Deno.test("erstelleNote: leerer Text wirft", async () => {
  await assertRejects(() => erstelleNote(client({ data: null }).client, "t", "u", { text: "  " }) as any, Error, "Text");
});

Deno.test("erstelleNote: Default-Sichtbarkeit ist intern", async () => {
  const c = client({ data: { id: "x" }, error: null });
  await erstelleNote(c.client, "t", "u", { text: "Bild überarbeiten" });
  assertEquals(c.calls.inserts[0].sichtbarkeit, "intern");
  assertEquals(c.calls.inserts[0].tenant_id, "t");
  assertEquals(c.calls.inserts[0].erstellt_von, "u");
});

Deno.test("erstelleNote: coachee-Sichtbarkeit wird übernommen", async () => {
  const c = client({ data: { id: "x" }, error: null });
  await erstelleNote(c.client, "t", "u", { text: "Feedback", sichtbarkeit: "coachee" });
  assertEquals(c.calls.inserts[0].sichtbarkeit, "coachee");
});

Deno.test("erstelleNote: ungültige Sichtbarkeit fällt auf intern zurück", async () => {
  const c = client({ data: { id: "x" }, error: null });
  await erstelleNote(c.client, "t", "u", { text: "x", sichtbarkeit: "public" });
  assertEquals(c.calls.inserts[0].sichtbarkeit, "intern");
});

Deno.test("setzeNoteSichtbarkeit: ungültiger Wert wirft", async () => {
  await assertRejects(() => setzeNoteSichtbarkeit(client({}).client, "t", "id", "bogus"), Error, "ungültige Sichtbarkeit");
});

Deno.test("setzeNoteSichtbarkeit: gültiger Wert wird gesetzt", async () => {
  const c = client({ error: null });
  await setzeNoteSichtbarkeit(c.client, "t", "id", "coachee");
  assertEquals(c.calls.updates[0].sichtbarkeit, "coachee");
});

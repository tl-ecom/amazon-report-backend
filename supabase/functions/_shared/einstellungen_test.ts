import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ladeEinstellungen, setzeEinstellungen } from "./einstellungen.ts";

function client(row: unknown) {
  const calls: any[] = [];
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: () => b,
    upsert: (r: any) => { calls.push(r); return b; },
    then: (res: any) => Promise.resolve({ data: row, error: null }).then(res),
  };
  return { client: { from: () => b } as any, calls };
}

Deno.test("ladeEinstellungen: Defaults, wenn nichts gespeichert", async () => {
  const r = await ladeEinstellungen(client(null).client, "t") as any;
  assertEquals(r.ziel_acos_prozent, null);
  assertEquals(r.kosten_abschlag_prozent, 0);
});

Deno.test("setzeEinstellungen: übernimmt Ziel-ACOS und Abschlag (Komma ok)", async () => {
  const c = client(null);
  await setzeEinstellungen(c.client, "t", { ziel_acos_prozent: "20,5", kosten_abschlag_prozent: 15 });
  assertEquals(c.calls[0].ziel_acos_prozent, 20.5);
  assertEquals(c.calls[0].kosten_abschlag_prozent, 15);
});

Deno.test("setzeEinstellungen: leeres Ziel-ACOS -> null erlaubt", async () => {
  const c = client(null);
  await setzeEinstellungen(c.client, "t", { ziel_acos_prozent: "", kosten_abschlag_prozent: 0 });
  assertEquals(c.calls[0].ziel_acos_prozent, null);
});

Deno.test("setzeEinstellungen: Werte außerhalb 0–100 werfen", async () => {
  await assertRejects(() => setzeEinstellungen(client(null).client, "t", { ziel_acos_prozent: 150 }), Error, "Ziel-ACOS");
  await assertRejects(() => setzeEinstellungen(client(null).client, "t", { kosten_abschlag_prozent: -5 }), Error, "Kosten-Abschlag");
});

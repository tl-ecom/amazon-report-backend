import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ertragVerlauf, setzeEk } from "./ertrag.ts";

function rpcClient(rows: unknown, finance: unknown[] = []) {
  const fin: any = {
    select: () => fin,
    eq: () => fin,
    then: (res: any) => Promise.resolve({ data: finance, error: null }).then(res),
  };
  return { rpc: () => Promise.resolve({ data: rows, error: null }), from: () => fin } as any;
}

function upsertClient() {
  const calls: any[] = [];
  const b: any = {
    upsert: (row: any) => { calls.push(row); return b; },
    select: () => b,
    single: () => b,
    then: (res: any) => Promise.resolve({ data: { id: "x" }, error: null }).then(res),
  };
  return { client: { from: () => b } as any, calls };
}

Deno.test("ertragVerlauf: Rohertrag, Rohmarge und EK-Abdeckung", async () => {
  const c = rpcClient([{ monat: "2026-06", umsatz_cents: 100000, einheiten: 10, wareneinsatz_cents: 40000, einheiten_mit_ek: 8 }]);
  const r = await ertragVerlauf(c, "t") as any;
  const m = r.monate[0];
  assertEquals(m.umsatz_bestellungen, 1000);
  assertEquals(m.wareneinsatz, 400);
  assertEquals(m.rohertrag, 600);
  assertEquals(m.rohmarge, 60);
  assertEquals(m.ek_abdeckung, 80); // 8 von 10 Einheiten mit EK
});

Deno.test("ertragVerlauf: Gebühren + Nettogewinn (Rohertrag + Gebühren)", async () => {
  const c = rpcClient(
    [{ monat: "2026-06", umsatz_cents: 100000, einheiten: 10, wareneinsatz_cents: 40000, einheiten_mit_ek: 10 }],
    [{ monat: "2026-06", gebuehren_cents: -15000 }],
  );
  const m = (await ertragVerlauf(c, "t") as any).monate[0];
  assertEquals(m.rohertrag, 600);
  assertEquals(m.gebuehren, -150); // signiert
  assertEquals(m.nettogewinn, 450); // 600 + (-150)
  assertEquals(m.nettomarge, 45); // 450/1000
  assertEquals(m.umsatz_nach_gebuehren, 850); // 1000 + (-150)
});

Deno.test("ertragVerlauf: ohne EK -> Rohertrag/Nettogewinn null, aber Gebühren + Umsatz−Gebühren da", async () => {
  const c = rpcClient(
    [{ monat: "2026-06", umsatz_cents: 100000, einheiten: 10, wareneinsatz_cents: 0, einheiten_mit_ek: 0 }],
    [{ monat: "2026-06", gebuehren_cents: -15000 }],
  );
  const m = (await ertragVerlauf(c, "t") as any).monate[0];
  assertEquals(m.rohertrag, null);
  assertEquals(m.nettogewinn, null);
  assertEquals(m.gebuehren, -150);
  assertEquals(m.umsatz_nach_gebuehren, 850);
});

Deno.test("ertragVerlauf: Umsatz 0 -> Rohmarge null (keine Div/0)", async () => {
  const c = rpcClient([{ monat: "2026-06", umsatz_cents: 0, einheiten: 0, wareneinsatz_cents: 0, einheiten_mit_ek: 0 }]);
  const r = await ertragVerlauf(c, "t") as any;
  assertEquals(r.monate[0].rohmarge, null);
  assertEquals(r.monate[0].ek_abdeckung, null);
});

Deno.test("setzeEk: Euro wird zu Cents (Punkt und Komma)", async () => {
  const a = upsertClient();
  await setzeEk(a.client, "t", "B01", 12.5, "2026-01-01");
  assertEquals(a.calls[0].ek_cents, 1250);

  const b = upsertClient();
  await setzeEk(b.client, "t", "B01", "12,50", "2026-01-01");
  assertEquals(b.calls[0].ek_cents, 1250);
});

Deno.test("setzeEk: fehlende ASIN / Datum / negativer EK werfen", async () => {
  await assertRejects(() => setzeEk(upsertClient().client, "t", "", 5, "2026-01-01") as any, Error, "ASIN");
  await assertRejects(() => setzeEk(upsertClient().client, "t", "B01", 5, "") as any, Error, "gueltig_ab");
  await assertRejects(() => setzeEk(upsertClient().client, "t", "B01", -1, "2026-01-01") as any, Error, "EK-Betrag");
});

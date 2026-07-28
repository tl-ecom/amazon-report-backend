import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ablehnenKonto, freigebenKonto, loeseFirmaAuf, meinKonto } from "./admin.ts";

// RPC-Stub: erfasst den letzten Aufruf und liefert wählbares Ergebnis/Fehler.
function rpcStub(result: unknown, fehler: string | null = null) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return Promise.resolve({ data: result, error: fehler ? { message: fehler } : null });
    },
  } as any;
  return { client, calls };
}

// Minimaler Supabase-Stub: steuert Admin-Status + Tenant-Existenz.
function stub(opts: { admin: boolean; tenantExists: boolean }) {
  return {
    from(table: string) {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => {
          if (table === "platform_admins") return { data: opts.admin ? { user_id: "u" } : null, error: null };
          if (table === "tenants") return { data: opts.tenantExists ? { id: "t" } : null, error: null };
          return { data: null, error: null };
        },
      };
    },
  } as any;
}

Deno.test("Kunde kann fremde Firma NICHT erzwingen (company_id wirkungslos -> 403)", async () => {
  const r = await loeseFirmaAuf(stub({ admin: false, tenantExists: true }), "u", "eigen", "fremd");
  assertEquals(r.tenant, undefined);
  assertEquals(r.code, 403);
});

Deno.test("Admin darf existierende fremde Firma wählen", async () => {
  const r = await loeseFirmaAuf(stub({ admin: true, tenantExists: true }), "u", null, "fremd");
  assertEquals(r.tenant, "fremd");
});

Deno.test("Admin + nicht existierende Firma -> 404", async () => {
  const r = await loeseFirmaAuf(stub({ admin: true, tenantExists: false }), "u", null, "gibtsnicht");
  assertEquals(r.code, 404);
});

Deno.test("Ohne company_id -> eigene Firma", async () => {
  const r = await loeseFirmaAuf(stub({ admin: false, tenantExists: true }), "u", "eigen", null);
  assertEquals(r.tenant, "eigen");
});

Deno.test("Admin ohne eigene Firma -> muss waehlen (409)", async () => {
  const r = await loeseFirmaAuf(stub({ admin: true, tenantExists: true }), "u", null, null);
  assertEquals(r.tenant, undefined);
  assertEquals(r.code, 409);
  assertEquals(r.is_admin, true);
});

Deno.test("Kunde ohne Firma -> 403", async () => {
  const r = await loeseFirmaAuf(stub({ admin: false, tenantExists: true }), "u", null, null);
  assertEquals(r.code, 403);
  assertEquals(r.is_admin, false);
});

Deno.test("freigebenKonto reicht caller/user/firmenname an die RPC durch", async () => {
  const { client, calls } = rpcStub(null);
  await freigebenKonto(client, "admin-id", "ziel-id", "Meine Firma");
  assertEquals(calls[0].name, "admin_konto_freigeben");
  assertEquals(calls[0].args, { p_caller: "admin-id", p_user_id: "ziel-id", p_firmenname: "Meine Firma" });
});

Deno.test("freigebenKonto ohne Firmenname sendet null", async () => {
  const s = rpcStub(null);
  await freigebenKonto(s.client, "a", "z");
  assertEquals((s.calls[0].args as any).p_firmenname, null);
});

Deno.test("ablehnenKonto wirft bei RPC-Fehler", async () => {
  const { client } = rpcStub(null, "boom");
  await assertRejects(() => ablehnenKonto(client, "a", "z"), Error, "admin_konto_ablehnen");
});

Deno.test("meinKonto liefert Default, wenn die RPC nichts zurückgibt", async () => {
  const { client } = rpcStub([]);
  const r = await meinKonto(client, "u");
  assertEquals(r, { status: "wartend", is_admin: false, has_tenant: false });
});

Deno.test("meinKonto entpackt die erste Zeile", async () => {
  const { client } = rpcStub([{ status: "freigegeben", is_admin: true, has_tenant: true }]);
  const r = await meinKonto(client, "u");
  assertEquals(r.status, "freigegeben");
  assertEquals(r.is_admin, true);
});

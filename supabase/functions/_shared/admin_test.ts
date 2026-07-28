import { assertEquals } from "jsr:@std/assert@1";
import { loeseFirmaAuf } from "./admin.ts";

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

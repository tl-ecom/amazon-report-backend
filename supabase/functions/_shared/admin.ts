// admin.ts — Plattform-Admin: darf die Firma frei wählen (fremde Tenants ansehen).
// Sicherheitskritisch. Die eigentliche Autorisierung (wer darf welchen Tenant
// sehen) macht die api; hier nur die Prüf-/Listen-Queries.

export async function istPlattformAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) return false;
  return Boolean(data);
}

/** Alle Tenants + Repräsentant-E-Mail + Aktivität. Die RPC prüft selbst, dass
 * der Aufrufer Admin ist (self-gating) — leere Liste für Nicht-Admins. */
export async function listeTenants(supabase: any, callerId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("admin_tenant_liste", { p_caller: callerId });
  if (error) throw new Error(`admin_tenant_liste: ${error.message}`);
  return { tenants: data ?? [] };
}

/**
 * Löst die effektiv anzuzeigende Firma auf.
 *  - Ohne company_id: eigene Firma (myTenant).
 *  - Mit company_id: NUR erlaubt, wenn der Nutzer Plattform-Admin ist UND der
 *    Tenant existiert. Sonst Fehler. So kann ein Kunde NIE eine fremde Firma
 *    erzwingen (company_id aus dem Body ist für Nicht-Admins wirkungslos).
 */
export async function loeseFirmaAuf(
  supabase: any,
  userId: string,
  myTenant: string | null,
  companyId: string | null | undefined,
): Promise<{ tenant?: string; fehler?: string; code?: number; is_admin: boolean }> {
  const admin = await istPlattformAdmin(supabase, userId);

  if (companyId) {
    if (!admin) return { fehler: "Nur Admins dürfen eine fremde Firma wählen.", code: 403, is_admin: false };
    const { data } = await supabase.from("tenants").select("id").eq("id", companyId).maybeSingle();
    if (!data) return { fehler: "Firma nicht gefunden.", code: 404, is_admin: true };
    return { tenant: companyId, is_admin: true };
  }

  if (myTenant) return { tenant: myTenant, is_admin: admin };

  // Kein eigener Tenant: Admin muss eine Firma wählen; Kunde hat schlicht keinen.
  return {
    fehler: admin ? "Bitte oben eine Firma auswählen." : "Dieser Nutzer ist keinem Tenant zugewiesen.",
    code: admin ? 409 : 403,
    is_admin: admin,
  };
}

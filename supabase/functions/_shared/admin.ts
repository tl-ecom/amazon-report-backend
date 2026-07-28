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

/** Nutzer-/Kundenliste für die Admin-Seite (Kundenverwaltung inkl. Freigabe-Status). */
export async function listeKunden(supabase: any, callerId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("admin_kunden_liste", { p_caller: callerId });
  if (error) throw new Error(`admin_kunden_liste: ${error.message}`);
  return { kunden: data ?? [] };
}

/** Eigener Konto-Status: entscheidet im Frontend Dashboard vs. Warte-/Abgelehnt-Screen.
 * Self — braucht keine Admin-Rechte, funktioniert auch OHNE Tenant. */
export async function meinKonto(supabase: any, callerId: string): Promise<{ status: string; is_admin: boolean; has_tenant: boolean }> {
  const { data, error } = await supabase.rpc("mein_konto_status", { p_caller: callerId });
  if (error) throw new Error(`mein_konto_status: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? { status: "wartend", is_admin: false, has_tenant: false };
}

/** Konto freigeben: legt bei Bedarf Firma + Mitgliedschaft an. Die RPC prüft selbst,
 * dass der Aufrufer Plattform-Admin ist (self-gating) — sonst wirft sie. */
export async function freigebenKonto(
  supabase: any, callerId: string, userId: string, firmenname?: string | null,
): Promise<{ ok: true }> {
  const { error } = await supabase.rpc("admin_konto_freigeben", {
    p_caller: callerId, p_user_id: userId, p_firmenname: firmenname ?? null,
  });
  if (error) throw new Error(`admin_konto_freigeben: ${error.message}`);
  return { ok: true };
}

/** Konto ablehnen: Status auf abgelehnt, kein Tenant. Self-gating in der RPC. */
export async function ablehnenKonto(
  supabase: any, callerId: string, userId: string,
): Promise<{ ok: true }> {
  const { error } = await supabase.rpc("admin_konto_ablehnen", { p_caller: callerId, p_user_id: userId });
  if (error) throw new Error(`admin_konto_ablehnen: ${error.message}`);
  return { ok: true };
}

/**
 * Direkte Einladung: verschickt eine Supabase-Invite-Mail (Nutzer setzt sein
 * Passwort über den bestehenden `type=invite`-Flow) und gibt das Konto SOFORT frei
 * — eine Einladung ist ja bereits eine bewusste Freigabe (kein "wartend"-Umweg).
 * Braucht die Admin-Auth-API, deshalb explizite Admin-Prüfung statt RPC-Self-Gate.
 */
export async function ladeEin(
  supabase: any, callerId: string, email: string, firmenname?: string | null,
): Promise<{ ok: true; email: string }> {
  if (!(await istPlattformAdmin(supabase, callerId))) {
    throw new Error("nicht autorisiert");
  }
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: firmenname ? { firmenname } : undefined,
  });
  if (error) throw new Error(`invite: ${error.message}`);

  const neu = data?.user;
  if (neu?.id) {
    // Direkt freigeben -> legt Firma + Mitgliedschaft an, Status = freigegeben.
    await supabase.rpc("admin_konto_freigeben", {
      p_caller: callerId, p_user_id: neu.id, p_firmenname: firmenname ?? null,
    });
  }
  return { ok: true, email };
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

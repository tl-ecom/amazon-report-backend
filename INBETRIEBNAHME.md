# Inbetriebnahme — das Backend scharfschalten

Das Backend ist gebaut, getestet und in der Cloud live. Aber drei Schritte kann
nur der Betreiber ausführen (Secrets / Amazon-Konto). Erst danach läuft das System
**produktiv**: täglicher Auto-Sync + KI-Zugriff.

Reihenfolge egal, aber Schritt 1 und 2 sind Pflicht, Schritt 3 optional.

Alle SQL-Befehle laufen im **Supabase Dashboard → SQL Editor**.
Werte, die du brauchst, findest du im Dashboard → Project Settings → API:
- **Project URL:** `https://irvnghhxfjjnpodclfuc.supabase.co`
- **service_role key:** dort unter „Project API keys" (geheim — nicht weitergeben)

---

## Schritt 1 — Scheduler scharfschalten (täglicher Auto-Sync)

**Warum:** Die zwei Cron-Jobs sind installiert und laufen, tun aber bewusst nichts,
solange zwei Vault-Secrets fehlen. Ohne sie geht kein Report-Abruf los.

**Tun** (SQL Editor, `<SERVICE_ROLE_KEY>` durch den echten Wert ersetzen):

```sql
select vault.create_secret(
  'https://irvnghhxfjjnpodclfuc.supabase.co',
  'project_url',
  'Basis-URL fuer Cron -> Edge-Function-Aufrufe'
);
select vault.create_secret(
  '<SERVICE_ROLE_KEY>',
  'service_role_key',
  'service_role fuer Cron -> sync-report'
);
```

**Erfolgskontrolle** (SQL Editor):

```sql
select public.scheduler_status();
```
Im Ergebnis muss `secrets_vorhanden` für **beide** `true` zeigen.

**Sofort testen** (statt bis 04:30 UTC zu warten):

```sql
select internal.cron_sync_alle_tenants();
```
Gibt die Anzahl angestoßener Report-Abrufe zurück (aktuell 3 Report-Typen × 1
Tenant = 3). Nach 1–2 Minuten stehen die frischen Daten in `report_data`.

> Sicherheit: `scheduler_status()` gibt Secrets nur als true/false zurück, nie den
> Wert. Der service_role_key steht nur im Vault, nie im Klartext abrufbar.

---

## Schritt 2 — MCP-Token ausstellen und KI-Client anbinden

**Warum:** Die KI (ChatGPT/Claude) authentifiziert sich mit einem Bearer-Token,
der den Tenant identifiziert. Ohne Token kein Zugriff (jeder Aufruf → 401).

**2a — Token erzeugen** (lokal in einer Shell; der Token wird EINMALIG angezeigt,
in der DB liegt nur sein Hash):

```bash
TOKEN="mcp_$(python -c 'import secrets;print(secrets.token_hex(24))')"
HASH=$(python -c "import hashlib;print(hashlib.sha256('$TOKEN'.encode()).hexdigest())")
echo "TOKEN (dem Kunden geben, danach nicht mehr abrufbar): $TOKEN"
echo "HASH  (in die DB):                                    $HASH"
```

**2b — Hash speichern** (SQL Editor, `<HASH>` und Tenant einsetzen):

```sql
insert into public.mcp_tokens (tenant_id, token_hash, name)
values ('62b44111-8088-493e-982c-e2c8d8452efa', '<HASH>', 'ChatGPT/Claude Testkonto');
```

**2c — Verbinden.** MCP-Endpunkt:
`https://irvnghhxfjjnpodclfuc.supabase.co/functions/v1/mcp`

Vorher per curl prüfen, dass alles steht:

```bash
curl -s -X POST "https://irvnghhxfjjnpodclfuc.supabase.co/functions/v1/mcp" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Erwartet: die drei Tools `get_sales_overview`, `get_orders_overview`,
`get_listings_overview`.

Dann im KI-Client als Remote-MCP / Custom Connector eintragen (Endpunkt-URL +
Bearer-Token). **Wichtig, ehrlich:** Ob ein bestimmter Client einen statischen
Bearer-Token akzeptiert oder OAuth erzwingt, ist clientabhängig und noch nicht
erprobt. Der Server selbst ist per Bearer nachweislich funktionsfähig (curl oben).
Falls dein Client zwingend OAuth verlangt, ist ein zusätzlicher OAuth-Layer nötig,
den es noch nicht gibt — dann hier melden.

**Token-Verwaltung** (SQL Editor):
```sql
select public.mcp_tokens_uebersicht('62b44111-8088-493e-982c-e2c8d8452efa'); -- ohne Hash/Klartext
update public.mcp_tokens set revoked = true where id = '<id>';               -- widerrufen
```

---

## Schritt 3 — FBA-Lagerbestand freischalten (optional)

**Warum:** `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` wird von Amazon mit
„Unauthorized / forbidden" abgelehnt — der App fehlt die Rolle **„Amazon
Fulfillment"**. Der Merchant-Bestand ist über Listings bereits abgedeckt; nur der
FBA-Lagerbestand (Reichweite, Inbound) fehlt bis dahin.

**Tun (im Amazon Seller Central / Developer Console):**
1. Bei der self-authorized App die Rolle **„Amazon Fulfillment"** anhaken.
2. Die App **neu autorisieren** — dabei entsteht ein **neuer Refresh-Token**.
3. Den neuen Refresh-Token im Vault aktualisieren (SQL Editor). Die Vault-ID des
   Refresh-Tokens steht in `auth_contexts`:
   ```sql
   select refresh_token_secret from public.auth_contexts
   where tenant_id = '62b44111-8088-493e-982c-e2c8d8452efa' and source = 'sp';
   -- dann:
   select vault.update_secret('<refresh_token_secret-id>', '<NEUER_REFRESH_TOKEN>');
   ```

**Erfolgskontrolle:**
```bash
# über sync-report (anon key als Bearer); sollte status DONE liefern statt "forbidden"
curl -s -X POST "https://irvnghhxfjjnpodclfuc.supabase.co/functions/v1/sync-report" \
  -H "Authorization: Bearer <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"tenant_id":"62b44111-8088-493e-982c-e2c8d8452efa","report_type":"GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA"}'
```
Läuft der Report durch, kann er in `internal.scheduler_reports` aufgenommen werden
(täglicher Sync) und bekommt ein eigenes Aufbereitungsmodul + MCP-Tool
(siehe UEBERGABE.md, „Was als Nächstes ansteht").

---

## Danach ist das System in Betrieb

- **Täglich 04:30 UTC:** alle aktiven Tenants ziehen automatisch Sales & Traffic,
  Orders und Listings. Alle 15 Min werden hängende Reports nachgefasst.
- **Jederzeit:** die KI fragt über MCP die aufbereiteten, deterministisch
  gerechneten Kennzahlen ab.

Gesundheitscheck jederzeit: `select public.scheduler_status();`

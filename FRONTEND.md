# Frontend-Anbindung — das Multi-Tenant-Portal

Das Backend ist bereit für ein Web-Frontend, in dem sich **Seller-Kunden einloggen
und nur ihre eigenen Daten sehen**. Diese Datei beschreibt, wie ein Frontend
(Lovable oder eigenes React/Vue/…) andockt.

## Prinzip

- Das Frontend nutzt **unser bestehendes Supabase** (nicht ein neues) für Auth und
  Datenzugriff.
- Nutzer loggt sich per **Supabase Auth** ein (E-Mail/Passwort).
- Danach ruft das Frontend den **Read-Endpunkt `api`** mit dem Session-Token.
- Der Tenant wird serverseitig aus der Identität abgeleitet (`my_tenant_id` über
  `auth.uid()`), NIE aus dem Request — ein Nutzer kann keine fremden Daten sehen.

## Verbindungsdaten (client-side, nicht geheim)

- **Supabase URL:** `https://irvnghhxfjjnpodclfuc.supabase.co`
- **anon key:** aus Dashboard → Project Settings → API (der `anon`/`public` Key;
  ist für Client-Nutzung gedacht, kein Geheimnis — aber NICHT den service_role key!)

## Der Read-Endpunkt

```
POST https://irvnghhxfjjnpodclfuc.supabase.co/functions/v1/api
Authorization: Bearer <supabase-session-access-token>
Content-Type: application/json

{ "resource": "<name>", "arguments": { ... } }
```

`resource` ist eine von:

| resource | Inhalt |
|----------|--------|
| `get_sales_overview` | Sales & Traffic: Umsatz, Sessions, CVR, je ASIN |
| `get_orders_overview` | Bestellungen je Kanal/ASIN/Status |
| `get_listings_overview` | Angebote/Bestand, Out-of-Stock (Merchant) |
| `get_product_performance` | ASIN-Steckbrief über alle Quellen (arg: `asin`, `limit`) |
| `get_returns_overview` | Retouren (aktuell `unvalidiert`) |
| `get_ads_overview` | Advertising: ACOS/ROAS je Kampagne/ASIN (Phase 2) |

Antwort: `{ ok, resource, tenant_id, data: <overview> }`. Bei Fehler:
`{ error, ... , verfuegbar: [...] }`.

Fehlercodes: 401 (nicht/ungültig angemeldet), 403 (Nutzer keinem Tenant
zugeordnet), 400 (resource fehlt/unbekannt).

CORS ist offen (`*`) — das Frontend darf von jeder Origin aufrufen.

## Beispiel (React / supabase-js)

```ts
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(SUPABASE_URL, ANON_KEY);

// Login
await supabase.auth.signInWithPassword({ email, password });

// Daten holen
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch(`${SUPABASE_URL}/functions/v1/api`, {
  method: "POST",
  headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ resource: "get_sales_overview" }),
});
const { data } = await res.json();   // data.gesamt.umsatzOrdered, data.proAsin, ...
```

## Einen Kunden-Nutzer anlegen (Betreiber)

Zwei Schritte: Auth-User + Zuordnung zum Tenant.

```sql
-- 1. Auth-User: im Dashboard unter Authentication → Add user (oder Admin-API).
-- 2. Zuordnung (SQL Editor), user_id aus Authentication kopieren:
insert into public.tenant_members (user_id, tenant_id, role)
values ('<auth-user-id>', '<tenant-id>', 'viewer');
```

Ein Nutzer ohne `tenant_members`-Eintrag bekommt vom `api`-Endpunkt 403.

## Amazon-Konto verbinden (Erst-Connect, Self-Auth / "Weg A")

Der Seller erzeugt in SEINER eigenen self-authorized App (Seller Central) client_id,
client_secret und einen refresh_token und trägt sie im Portal ein. Das Frontend
POSTet sie mit dem Session-Token:

```
POST https://irvnghhxfjjnpodclfuc.supabase.co/functions/v1/connect-sp
Authorization: Bearer <session-access-token>
Content-Type: application/json

{ "client_id": "...", "client_secret": "...", "refresh_token": "...",
  "marketplace_id": "A1PA6795UKMFR9", "region": "eu" }
```

- Die Function **prüft die Zugangsdaten live bei Amazon**, BEVOR sie speichert.
  Sind sie falsch → HTTP 400 `"Amazon lehnt die Zugangsdaten ab"` (+ Amazons
  `error`/`error_description`), und es wird **nichts** gespeichert.
- Erfolg → HTTP 200 `{ ok, status:"connected", access_token_laenge, expires_in }`.
  **Secrets werden nie zurückgegeben.** Ein erneuter Connect überschreibt die alten
  Vault-Werte (Reconnect ist idempotent).
- Pflichtfelder: client_id, client_secret, refresh_token, marketplace_id. `region`
  optional (default `eu`).

Im Formular deutlich machen: Der Seller braucht eine EIGENE Amazon-App (kein
zentrales OAuth-Login). Das client_secret/refresh_token nur über HTTPS senden,
nie im Frontend zwischenspeichern/loggen.

## Hinweise für den Frontend-Bau

- Die Zahlen kommen FERTIG GERECHNET vom Backend (deterministisch, getestet). Das
  Frontend soll NICHT selbst rechnen — nur anzeigen.
- Beachte die `warnungen`- und `is_provisional`/`unvalidiert`-Felder in den
  Antworten und zeige sie an (z.B. „Ads-Zahlen vorläufig", „Umsatz unvollständig").
- `get_product_performance` führt mehrere Quellen mit VERSCHIEDENEN Zeiträumen/
  Kanälen zusammen — die `warnung` im Ergebnis nicht verstecken.

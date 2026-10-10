# Operator Pulse — SP-API Public-App Readiness Audit

Stand: 2026-10-05. Grundlage: `amazon-report-backend` (28 Edge Functions, 235 Migrationen,
82 Tabellen in `public`) und `amazon-report-frontend`.

Methode: Lesen des Repositories plus Abfragen gegen das Live-Schema des Supabase-Projekts
`irvnghhxfjjnpodclfuc`. Kein Code geändert. Jede Aussage, die nicht belegt werden konnte,
ist als **NOT VERIFIED** markiert.

---

## 1. SP-API-Nutzung

Endpoint-Basis durchgehend `https://sellingpartnerapi-eu.amazon.com` (EU).
Amazon Ads läuft getrennt über `https://advertising-api-eu.amazon.com`.

### 1.1 Direkt aufgerufene SP-API-Operationen

| Operation | Datei | Zweck | Wahrscheinlich nötige Rolle |
|---|---|---|---|
| `GET /sellers/v1/marketplaceParticipations` | `connect-sp/index.ts` | Credential-Prüfung beim Verbinden | Keine eigene Rolle (Basisprüfung) |
| `POST /reports/2021-06-30/reports` | `sync-report`, `request-report`, `sync-sqp` | Report anfordern | je Report-Typ, siehe 1.2 |
| `GET /reports/2021-06-30/reports/{id}` | `sync-report`, `check-report`, `sync-sqp` | Status pollen | wie oben |
| `GET /reports/2021-06-30/documents/{id}` | `sync-report`, `fetch-report`, `sync-sqp` | Dokument holen | wie oben |
| `GET /finances/v0/financialEvents` | `sync-finances/index.ts` | Finanzereignisse | Finanzen und Buchhaltung |
| `GET /catalog/2022-04-01/items` | `sync-katalog/index.ts` | Katalogdaten (`dimensions,summaries`) | Produktlisting / Katalog |
| `GET /customerFeedback/2024-06-01/items/{asin}/reviews/topics` | `sync-reviews/index.ts` | Rezensionsthemen | Brand Analytics bzw. Selling Partner Insights |
| `GET /customerFeedback/2024-06-01/items/{asin}/reviews/trends` | `sync-reviews/index.ts` | Themen-Monatsverlauf | wie oben |

### 1.2 Genutzte Report-Typen

Registry: `supabase/functions/sync-report/index.ts`, Konstante `REPORT_KONFIG`.

| Report-Typ | Zweck | Wahrscheinlich nötige Rolle |
|---|---|---|
| `GET_SALES_AND_TRAFFIC_REPORT` | Umsatz/Sessions je Tag und ASIN | Brand Analytics |
| `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` | Bestellpositionen | Lagerbestands- und Bestellungsverfolgung |
| `GET_MERCHANT_LISTINGS_ALL_DATA` | Angebotsbestand | Produktlisting |
| `GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE` | Merchant-Retouren | Lagerbestands- und Bestellungsverfolgung |
| `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | FBA-Retouren | Lagerbestands- und Bestellungsverfolgung |
| `GET_FBA_REIMBURSEMENTS_DATA` | Erstattungen | Finanzen und Buchhaltung |
| `GET_LEDGER_DETAIL_VIEW_DATA` | Bestandsbewegungen | Lagerbestands- und Bestellungsverfolgung |
| `GET_LEDGER_SUMMARY_VIEW_DATA` | Tagesbestand je SKU | Lagerbestands- und Bestellungsverfolgung |
| `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` | FBA-Bestand (Momentaufnahme) | Lagerbestands- und Bestellungsverfolgung |
| `GET_FBA_INVENTORY_PLANNING_DATA` | Bestandsplanung, Rückfall für MYI | Lagerbestands- und Bestellungsverfolgung |
| `GET_FBA_INVENTORY_AGED_DATA` | Bestandsalter | Lagerbestands- und Bestellungsverfolgung |
| `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` | Gebührenvorschau je SKU | Finanzen und Buchhaltung |
| `GET_FBA_STORAGE_FEE_CHARGES_DATA` | Lagergebühren | Finanzen und Buchhaltung |
| `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | Abrechnungsberichte | Finanzen und Buchhaltung |
| `GET_V2_SELLER_PERFORMANCE_REPORT` | Kontozustand | Kontozustand / Account Health |
| `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT` | Suchbegriff-Performance | Brand Analytics |

Die Rollenzuordnung ist eine Einschätzung aus Amazons Rollenmodell, **nicht** aus dem
Repository belegt — die App-Konfiguration in Amazons Developer Central liegt nicht im
Code. **NOT VERIFIED: welche Rollen die App tatsächlich beantragt hat.**

### 1.3 Restricted Data / Käufer-PII

Es gibt eine ausdrückliche PII-Filterung **vor dem Speichern**
(`sync-report/index.ts`, Feld `piiSpalten`; Implementierung `_shared/tsv.ts`,
Funktion `entferneSpalten`):

| Report | verworfene Spalten |
|---|---|
| `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` | `ship-city`, `ship-state`, `ship-postal-code` |
| `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | `customer-comments` |

Live gegengeprüft: in `report_data.payload` steht `entfernteSpalten:
["ship-city","ship-state","ship-postal-code"]`, der verbliebene `header` enthält
keine Käufernamen, keine Adressen, keine Mailadressen. `ship-country` bleibt
bewusst erhalten (Marktplatzzuordnung).

Es wird **keine** PII-pflichtige Operation aufgerufen: kein `getOrders` mit
`BuyerInfo`/`ShippingAddress`, kein `getOrderBuyerInfo`, kein Messaging-API,
kein `GET_..._ORDERS_DATA` in der PII-Variante.

Einschränkung: `returns_history.raw` und `settlement_zeilen.raw` speichern die
Rohzeile als JSONB. Für diese beiden Pfade ist die PII-Filterung **nicht**
geprüft — `GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE` hat in der Registry keine
`piiSpalten`, der Kommentar begründet das mit „keine ship-*-Spalten". Ob der
Report in anderen Marktplätzen zusätzliche Felder liefert, ist **NOT VERIFIED**.

### 1.4 Möglicherweise entbehrlicher Zugriff

- `GET_V2_SELLER_PERFORMANCE_REPORT` (Kontozustand) hängt an einer eigenen Rolle.
  Für die Kernfunktionen (Ertrag, Bestand, Werbung, Cash-Flow) wird er nicht
  gebraucht. Eine Rolle weniger im Antrag ist eine Prüfung weniger.
- `customerFeedback` ist neu (seit 2026-09-14) und liefert bisher nur Themen;
  der Trend-Endpunkt gibt in der aktuellen Implementierung 0 Punkte zurück.
  Nutzen derzeit begrenzt, Rollenbedarf aber identisch mit Brand Analytics (SQP),
  also kein zusätzlicher Antragsaufwand.

---

## 2. Amazon-OAuth / Login with Amazon

### 2.1 Kernbefund

**Es gibt keinen Amazon-OAuth-Flow.** `connect-sp/index.ts` dokumentiert im
Dateikopf ausdrücklich: *„KEIN OAuth-Code-Tausch: Der Seller hat in SEINER eigenen
self-authorized App (Seller Central) bereits einen Refresh-Token erzeugt."*

Der Seller übergibt `client_id`, `client_secret` und `refresh_token` als
Formularfelder. Das ist das Self-Authorization-Modell für private Apps und
**nicht** der Weg, den Amazon für öffentliche Apps vorsieht
(Authorization-Code-Flow über den Amazon Appstore bzw. die Website-Autorisierung
mit `spapi_oauth_code` → `refresh_token`).

Dasselbe gilt für `connect-ads/index.ts` (Ads-API, ebenfalls Credential-Eingabe).

Der vorhandene `oauth`-Endpunkt (`supabase/functions/oauth/`, `_shared/oauth.ts`,
Tabellen `oauth_clients`, `oauth_auth_codes`, `oauth_tokens`, `oauth_ereignisse`)
ist ein **OAuth-2.1-Server für MCP-Clients** (ChatGPT, Claude). Er hat mit Amazon
nichts zu tun.

### 2.2 Prüfpunkte

| Punkt | Befund |
|---|---|
| Mehrere unabhängige Seller | Technisch ja: `auth_contexts` je `(tenant_id, source)`, aktuell 4 Mandanten / 5 Verbindungen. Aber jeder Seller braucht eine EIGENE self-authorized App. |
| OAuth-Flow dokumentiert | Für Amazon nicht vorhanden. Für MCP vorhanden und getestet. |
| `state`-Erzeugung/-Prüfung | Für Amazon nicht vorhanden (kein Redirect-Flow). Im MCP-OAuth-Server vorhanden (`_shared/oauth.ts`). |
| Redirect-URI-Handhabung | Für Amazon nicht vorhanden. |
| Refresh-Token-Speicherung | Supabase Vault, Referenz als UUID in `auth_contexts.refresh_token_secret`. |
| Refresh-Token-Rotation | Für Amazon-Tokens **nicht implementiert** — der Token wird einmal abgelegt und unverändert benutzt. Eine Rotationslogik mit Schonfrist existiert, betrifft aber die MCP-Tokens (`20260824103148_refresh_token_schonfrist.sql`). |
| Widerruf / Trennen | Für Amazon **nicht vorhanden**. Es gibt nur `sellerboard_bestand_trennen` (Drittquelle). Kein `amazon_trennen`, kein Löschen von `auth_contexts` über die API. |
| Jährliche Reauthorisierung | Nicht unterstützt. Kein Ablaufdatum, keine Erinnerung, kein Erneuerungspfad. |

---

## 3. Credentials und Secrets

### 3.1 Ablageorte

| Secret | Ort | Beleg |
|---|---|---|
| SP-API `client_id`, `client_secret`, `refresh_token` | Supabase Vault, je Tenant eigener Eintrag (`sp_client_id_<tenant>` …) | `connect-sp/index.ts:111-113` |
| Ads `client_id`, `client_secret`, `refresh_token` | Supabase Vault (`ads_refresh_token_<tenant>` …) | `connect-ads/index.ts:98` |
| Vault-Referenzen | `auth_contexts.client_id_secret`, `.client_secret_secret`, `.refresh_token_secret` (UUID) | Schema |
| `project_url`, `service_role_key` | Supabase Vault, von pg_cron/pg_net-RPCs gelesen | diverse Migrationen |
| MCP-Tokens | **nur als SHA-256-Hash** in `mcp_tokens.token_hash` | `_shared/mcp_tokens.ts:8,72` |
| Sellerboard-URLs (enthalten Geheimnis im Pfad) | Vault (`sellerboard_*_url_secret`) | Schema |
| Supabase-Anon-Key, Supabase-URL | Netlify Build-Env, landen im Frontend-Bundle | `netlify.toml`, `src/lib/supabase.ts` |

Zugriff auf den Vault ausschließlich über zwei RPCs, beide `SECURITY DEFINER`
mit `revoke … from public, anon, authenticated` und `grant execute … to
service_role` (`20260716000002_read_vault_secret.sql`,
`20260718000008_upsert_vault_secret.sql`).

### 3.2 Exposition

- Kein `.env` im Git getrackt, nur `.env.example`.
- Keine Treffer für `service_role_key` in der Git-Historie von `*.ts`/`*.toml`/`*.json`.
- Im Frontend liegen nur `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_MCP_PUBLIC_BASE` — alle öffentlich gedacht.
- `connect-sp` und `connect-ads` geben Secrets nicht zurück und loggen sie nicht
  (im Code geprüft).
- **NOT VERIFIED:** ob in den Supabase-Function-Logs (Laufzeit) je ein Secret
  gelandet ist. Die Logtabellen waren über die genutzte Schnittstelle nicht
  abfragbar.

### 3.3 Verschlüsselung im Ruhezustand

Supabase Vault verschlüsselt mit `pgsodium`/TDE oberhalb der normalen
Datenbankverschlüsselung. Die Amazon-Credentials liegen dort, nicht im Klartext
in Anwendungstabellen. Das ist der einzige Ort mit Verschlüsselung über die
Datenbankebene hinaus; alle übrigen Amazon-Daten liegen unverschlüsselt in
normalen Tabellen.

### 3.4 Wer kann zugreifen

- `service_role` (Edge Functions, pg_cron/pg_net) — vollständig, RLS wird umgangen.
- Betreiber über die Supabase-Konsole — vollständig.
- Dieses Supabase-Projekt ist **mit einem zweiten Produkt geteilt** (ByteBloom-
  Migrationen im Verlauf desselben Projekts). Wer dort `service_role` hat, hat es
  auch hier. Das ist für eine Mehrmandanten-Amazon-App eine relevante Aussage.
- `anon`/`authenticated` — kein Vault-Zugriff, keine der beiden RPCs ausführbar.

---

## 4. Mehrmandantenfähigkeit und Seller-Isolation

### 4.1 Modell

- `tenants` — eine Firma.
- `tenant_members` — Zuordnung `user_id` → `tenant_id`.
- `auth_contexts` — Amazon-Verbindung je `(tenant_id, source)` mit `source` in
  `sp` | `ads`, dazu `marketplace_id`, `profile_id`, `status`.
- Jede fachliche Tabelle trägt `tenant_id` als erste Schlüsselspalte.

### 4.2 Wie Trennung durchgesetzt wird

Live geprüft: **82 Tabellen, alle mit `rowsecurity = true`, aber nur 7 Policies
auf 5 Tabellen.**

| Tabelle | Policy | Bedingung |
|---|---|---|
| `auth_contexts` | SELECT | `tenant_id = current_tenant_id()` |
| `report_data` | SELECT/UPDATE | `tenant_id = current_tenant_id()` |
| `report_data` | INSERT | ohne Bedingung |
| `report_jobs` | SELECT | `tenant_id = current_tenant_id()` |
| `tenant_members` | SELECT | `user_id = auth.uid()` |
| `tenants` | SELECT | `id = current_tenant_id()` |

Die übrigen 77 Tabellen haben RLS aktiv **ohne jede Policy**. Für `anon` und
`authenticated` heißt das: kein Zugriff. Das ist die dokumentierte Konvention des
Projekts („RLS an ohne Policies, Zugriff nur via service_role").

Daraus folgt: **Die Mandantentrennung ist nicht in der Datenbank durchgesetzt,
sondern im Anwendungscode.** Jede Abfrage in den Edge Functions muss
`.eq("tenant_id", …)` enthalten. Es gibt keine Datenbankschicht, die einen
vergessenen Filter abfängt.

### 4.3 Tenant-Auflösung

`api/index.ts`: Tenant kommt aus `my_tenant_id()` über `auth.uid()`, nicht aus
dem Body (Zeile 113). `company_id` aus dem Body wirkt **nur für
Plattform-Admins** (`loeseFirmaAuf`, Zeile 273). Das ist der gewollte
Coach-Zugriff und ein bewusster, geprüfter Bypass.

`mcp/index.ts`: Tenant aus dem Bearer-Token-Hash.

### 4.4 Befunde

- Kein automatischer Schutz gegen einen vergessenen `tenant_id`-Filter.
- `report_data` INSERT-Policy ohne `WITH CHECK`-Bedingung: ein Rollenwechsel,
  der heute nicht existiert, könnte fremde `tenant_id` einfügen.
- Der Plattform-Admin sieht per Konstruktion alle Mandanten. Für eine
  öffentliche App ist das zu dokumentieren und zu begrenzen.

---

## 5. Datenlebenszyklus

### 5.1 Gespeicherte Amazon-Daten

| Datenart | Tabelle | Zweck | Aufbewahrung | Löschweg |
|---|---|---|---|---|
| Rohreports (alle Typen) | `report_data.payload` (JSONB) | Quelle aller Auswertungen | unbegrenzt, `is_latest`-Flag, alte Stände bleiben | keiner |
| Bestellpositionen | `orders_history` | Umsatz, Absatz | unbegrenzt | keiner |
| Retouren | `returns_history` inkl. `raw` | Retourenquote | unbegrenzt | keiner |
| Abrechnungszeilen | `settlement_zeilen` inkl. `raw` | Cash-Flow, Gebühren, USt | unbegrenzt | keiner |
| Katalog/ASINs | `asins`, `katalog_masse` | Produktnamen, Maße | unbegrenzt | keiner |
| FBA-Bestand und -Historie | `fba_bestand`, `fba_bestand_verlauf`, `fba_bestandsalter` | Reichweite, Lagerkosten | unbegrenzt | keiner |
| Gebühren | `finance_gebuehren`, `fba_gebuehrenvorschau` | Ertragsrechnung | unbegrenzt | keiner |
| Erstattungen, Adjustments | `fba_reimbursements`, `fba_inventar_adjustments` | Erstattungsradar | unbegrenzt | keiner |
| SQP | `sqp_rows`, `sqp_laeufe` | Suchbegriffe | unbegrenzt | keiner |
| Rezensionsthemen | `reviews_themen`, `reviews_trend`, `reviews_laeufe` inkl. `roh` | Themenanalyse | unbegrenzt | keiner |
| Ads (7 Tabellen) | `ads_daily`, `ads_ziele_daily`, `ads_suchbegriffe_daily`, `ads_placement_daily`, `ads_kampagnen`, `ads_anzeigengruppen`, `ads_ziele` | Werbeauswertung | unbegrenzt | keiner |
| Credentials | Supabase Vault | API-Zugriff | unbegrenzt | keiner |

### 5.2 Was beim Trennen passiert

**Nichts.** Es gibt keinen Amazon-Trennen-Pfad. Weder eine Aktion in `api`, noch
eine RPC, noch eine Function löscht `auth_contexts`, Vault-Einträge oder
Amazon-Daten. Die einzige Trennfunktion im Code betrifft Sellerboard
(`sellerboard_bestand_import.ts:132`).

### 5.3 Folge

Eine Lösch- und Aufbewahrungsrichtlinie ist derzeit **nicht erfüllbar**: es gibt
keinen Mechanismus, der Amazon-Daten eines Sellers vollständig und nachweisbar
entfernt. `tenants` hat zwar `on delete cascade` an vielen Fremdschlüsseln
(z. B. `ads_profile`, `reviews_themen`), aber (a) ein Tenant-Löschweg ist nicht
exponiert, (b) die Vault-Einträge hängen nicht am Cascade, (c) **NOT VERIFIED:**
ob alle 82 Tabellen einen Fremdschlüssel auf `tenants` mit Cascade haben.

---

## 6. Sicherheitskontrollen

Nur Belegtes. Nicht Belegbares ist als fehlend oder NOT VERIFIED markiert.

| Kontrolle | Befund | Beleg |
|---|---|---|
| HTTPS/TLS | Supabase und Netlify liefern ausschließlich HTTPS. Alle Amazon-Aufrufe gegen `https://`. | Code |
| Authentifizierung Web | Supabase-Session-JWT, `verify_jwt = true` auf `api` | `api/index.ts` Kopf |
| Authentifizierung KI/MCP | Bearer-Token, serverseitig als SHA-256 verglichen | `_shared/mcp_tokens.ts` |
| Autorisierung | Tenant aus Identität, nicht aus dem Body; Feature-Gating über `entitlements.ts` | `api/index.ts:113,273,287` |
| Admin-Schutz | `istPlattformAdmin()` vor Connect- und Admin-Aktionen | `connect-sp/index.ts:64` |
| MFA | **Nicht vorhanden.** Login nur `signInWithPassword`. | `src/components/Login.tsx:23` |
| Brute-Force-Schutz | **Nicht im Code.** Supabase-Auth hat eigene Grenzen — **NOT VERIFIED**, ob konfiguriert. | — |
| Rate-Limiting ausgehend | Ja, gegen Amazon: `_shared/ratelimit.ts` liest `x-amzn-RateLimit-Limit`, mit 429-Wiederholung | `sync-report`, `sync-sqp` |
| Rate-Limiting eingehend | **Nicht vorhanden.** | — |
| WAF / Edge-Schutz | **Nicht konfiguriert** im Repository. | `netlify.toml` |
| Eingabevalidierung | Punktuell und sauber (Marktplatz-Whitelist, USt-Sätze, ASIN-Regex, Datumsformat). Kein Schema-Validator durchgängig. | `sqp.ts`, `einstellungen.ts` |
| CSRF | Bearer-Token statt Cookies → strukturell wenig relevant. CORS `Access-Control-Allow-Origin: "*"` in 6 Functions. | 6 Dateien |
| Sichere Header | **Keine.** Kein `_headers`, kein `[[headers]]` in `netlify.toml`: kein HSTS, kein CSP, kein X-Frame-Options, kein X-Content-Type-Options. | geprüft |
| Referrer-Policy | **Nicht gesetzt.** | geprüft |
| Logging / Audit | Teilweise: `ads_gebote_log`, `ads_aenderungen_log` (Schreibzugriffe mit vorher/nachher), `oauth_ereignisse`, `kpi_wache_log`, `report_jobs`. **Kein** Zugriffs-Audit für Lesezugriffe, kein Admin-Zugriffslog. | Schema |
| Secrets-Exposition | Siehe 3.2 — im Repository keine gefunden. | — |
| Abhängigkeiten | Nur zwei: `jsr:@supabase/supabase-js@2`, `jsr:@std/assert@1`. Beide auf Major gepinnt, nicht exakt. Kein Lockfile für Deno-Imports im CI geprüft. | geprüft |
| Backup / Recovery | **NOT VERIFIED.** Supabase-PITR/Backups sind Projekteinstellung, nicht im Repo. | — |
| Monitoring / Incident | Sync-Wache: tägliche Mail bei Ausfällen (`sync_stoerungen()` + Resend). Deckt Datenlieferung ab, **nicht** Sicherheitsereignisse. | Migrationen |

---

## 7. Architektur

```
                        ┌──────────────────────────────┐
 Browser ──HTTPS──────▶ │ Netlify (SPA, Vite/React)    │
                        │ pulse.amz-connect.de         │
                        │ VITE_SUPABASE_URL/ANON_KEY   │
                        └──────────────┬───────────────┘
                                       │ Supabase-Session-JWT
                                       ▼
 ChatGPT / Claude ──Bearer──▶ ┌────────────────────────────────────┐
   (via mcp.amz-connect.de    │ Supabase Edge Functions (Deno)     │
    → Netlify-Rewrite)        │  api · mcp · oauth · connect-sp    │
                              │  connect-ads · sync-* (14) · …     │
                              └───────┬─────────────────┬──────────┘
                                      │ service_role    │ LWA-Token
                                      ▼                 ▼
                        ┌──────────────────────┐  ┌──────────────────────┐
                        │ Supabase Postgres    │  │ Amazon               │
                        │  82 Tabellen         │  │  SP-API (EU)         │
                        │  RLS an, 7 Policies  │  │  Ads-API (EU)        │
                        │  Vault (Credentials) │  │  LWA Token-Endpoint  │
                        │  pg_cron + pg_net ───┼──┘                      │
                        └──────────┬───────────┘                         │
                                   │                                     │
                                   ├── Resend (Mailversand, Wache/Brief) │
                                   └── Sellerboard (CSV-Export-URLs) ────┘

 Hinweis: dasselbe Supabase-Projekt beherbergt zusätzlich ByteBloom.
```

Datenfluss Amazon → Pulse:
`pg_cron` → `pg_net.http_post` → `sync-*` Function → Vault lesen → LWA
`refresh_token` → `access_token` → SP-API/Ads-API → PII-Filter (`entferneSpalten`)
→ `report_data` + Fachtabellen → Leseschicht (`_shared/*.ts`) → `api`/`mcp`.

Externe Quellen ohne Amazon-Bezug: Sellerboard (EK-Preise, Bestand,
Abgleich-CSV), Resend (Mail). Helium 10 ist **nicht** angebunden — die Daten
kamen manuell.

---

## 8. Public-App-Readiness

Kurzantwort: **Die aktuelle Architektur kann mehrere Seller technisch tragen, ist
aber als öffentliche Amazon-App nicht einreichbar.** Der blockierende Punkt ist
nicht die Datenhaltung, sondern der Autorisierungsweg: Amazon erwartet bei einer
öffentlichen App, dass der Seller über den LWA-Autorisierungsflow zustimmt. Pulse
lässt sich stattdessen die Zugangsdaten einer fremden privaten App aushändigen.

### P0 — vor der Einreichung zu beheben

**P0-1 Kein Amazon-OAuth-Autorisierungsflow**
- Aktuell: Seller gibt `client_id`, `client_secret`, `refresh_token` ein.
- Beleg: `supabase/functions/connect-sp/index.ts:1-15,54,90`; gleiches Muster in `connect-ads/index.ts:52`.
- Risiko: Entspricht nicht dem Modell für öffentliche Apps. Der Seller gibt zudem ein `client_secret` heraus, was Amazon untersagt. Ablehnung praktisch sicher.
- Empfehlung: Autorisierungsflow bauen — Autorisierungs-URL mit `application_id`, `state`, Redirect-Endpoint, Tausch `spapi_oauth_code` → `refresh_token` mit dem **eigenen** LWA-Client. `connect-sp` auf diesen Weg umstellen, Self-Auth höchstens als internes Werkzeug behalten.
- Aufwand: hoch

**P0-2 Kein Trennen, kein Löschen von Amazon-Daten**
- Aktuell: Kein Pfad entfernt `auth_contexts`, Vault-Einträge oder Amazon-Daten.
- Beleg: Suche nach Trenn-/Löschpfaden findet nur `sellerboard_bestand_trennen` (`api/index.ts:410`).
- Risiko: Amazons Anforderungen an Datenaufbewahrung und -löschung sind nicht erfüllbar. Auch DSGVO-relevant.
- Empfehlung: `amazon_trennen(tenant)` — Vault-Einträge löschen, `auth_contexts` entfernen, laufende Jobs stoppen; dazu `amazon_daten_loeschen(tenant)` über alle Tabellen mit `tenant_id`, mit Protokoll. Aufbewahrungsfrist festlegen und als Cron durchsetzen.
- Aufwand: mittel

**P0-3 `state`-Parameter und Redirect-Validierung fehlen (Folge aus P0-1)**
- Aktuell: nicht vorhanden, weil es keinen Redirect-Flow gibt.
- Risiko: Ohne `state` ist der künftige Flow CSRF-anfällig.
- Empfehlung: `state` kryptografisch erzeugen, serverseitig mit kurzer Lebensdauer speichern, beim Rücksprung einmalig prüfen. Redirect-URI gegen eine feste Whitelist.
- Aufwand: niedrig (zusammen mit P0-1)

**P0-4 Mandantentrennung nur im Anwendungscode**
- Aktuell: 82 Tabellen mit RLS, 7 Policies; Isolation hängt an `.eq("tenant_id", …)` in jeder Abfrage.
- Beleg: `pg_policies` (live), Konvention im Projekt.
- Risiko: Ein vergessener Filter in einer von ~95 Leseschicht-Dateien legt fremde Sellerdaten offen. Bei unabhängigen Sellern ist das der schwerwiegendste Einzelfehler.
- Empfehlung: Mindestens für alle Tabellen mit Amazon-Daten echte Policies auf `tenant_id = current_tenant_id()`, und die Edge Functions von `service_role` auf eine tenant-gebundene Rolle umstellen. Alternativ, falls `service_role` bleiben muss: automatisierter Test, der jede Leseschicht-Funktion mit zwei Mandanten aufruft und auf Lecks prüft.
- Aufwand: hoch

**P0-5 Keine jährliche Reauthorisierung**
- Aktuell: kein Ablauf, keine Erinnerung, kein Erneuerungsweg.
- Risiko: Amazon verlangt sie für öffentliche Apps.
- Empfehlung: `autorisiert_am` in `auth_contexts`, Cron prüft Alter, Mail und Banner ab 11 Monaten, Reauthorisierung über denselben Flow wie P0-1.
- Aufwand: niedrig (nach P0-1)

### P1 — vor der Prüfung dringend empfohlen

**P1-1 Keine MFA für Betreiber- und Admin-Konten**
- Beleg: `src/components/Login.tsx:23`, nur Passwort.
- Risiko: Ein Admin-Konto sieht alle Mandanten (`loeseFirmaAuf`). Übernahme = Zugriff auf alle Sellerdaten.
- Empfehlung: Supabase-MFA (TOTP) für Plattform-Admins erzwingen.
- Aufwand: niedrig

**P1-2 Keine Sicherheits-Header**
- Beleg: kein `_headers`, keine `[[headers]]` in `netlify.toml`.
- Risiko: Kein HSTS, kein CSP, kein Clickjacking-Schutz, keine Referrer-Policy.
- Empfehlung: `[[headers]]`-Block mit `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Aufwand: niedrig

**P1-3 CORS offen (`Allow-Origin: *`) in sechs Functions**
- Risiko: Jede Website kann die Endpunkte aufrufen. Die Auth greift zwar, aber die Angriffsfläche ist unnötig groß.
- Empfehlung: Auf die eigenen Origins einschränken.
- Aufwand: niedrig

**P1-4 Geteiltes Supabase-Projekt**
- Beleg: ByteBloom-Migrationen in der Historie desselben Projekts.
- Risiko: Wer dort `service_role` hat, hat Zugriff auf alle Amazon-Daten. Gegenüber Amazon schwer zu vertreten.
- Empfehlung: Amazon-Daten in ein eigenes Supabase-Projekt trennen.
- Aufwand: hoch

**P1-5 Kein Zugriffsprotokoll für Lesezugriffe und Admin-Wechsel**
- Beleg: Schreibzugriffe werden protokolliert (`ads_gebote_log`), Lesezugriffe nicht.
- Risiko: Ein unbefugter Zugriff auf Sellerdaten wäre nicht nachweisbar.
- Empfehlung: Mindestens jeden Admin-Mandantenwechsel (`company_id`) und jeden MCP-Tokenzugriff protokollieren.
- Aufwand: niedrig

**P1-6 Kein eingehendes Rate-Limiting, kein WAF**
- Empfehlung: Supabase-Auth-Limits prüfen und dokumentieren, Netlify-Edge-Rate-Limit oder Cloudflare davor.
- Aufwand: mittel

### P2 — nach der Freigabe

- **P2-1** `report_data`-INSERT-Policy ohne `WITH CHECK` — enge Bedingung ergänzen. Aufwand: niedrig
- **P2-2** `GET_V2_SELLER_PERFORMANCE_REPORT` streichen, falls die Rolle nicht gebraucht wird — ein Prüfpunkt weniger. Aufwand: niedrig
- **P2-3** Aufbewahrungsfristen je Datenart definieren und als Cron durchsetzen (Rohreports älter als X Monate verdichten oder löschen). Aufwand: mittel
- **P2-4** `returns_history.raw` und `settlement_zeilen.raw` auf PII durchsehen und wie bei Orders filtern. Aufwand: niedrig
- **P2-5** Abhängigkeiten exakt pinnen statt auf Major. Aufwand: niedrig
- **P2-6** Backup- und Wiederherstellungsverfahren dokumentieren und einmal testen. Aufwand: niedrig

---

## AMAZON APPLICATION FACTS

Nur aus dem Repository und dem Live-Schema belegte Angaben.

**Produktarchitektur**
React-SPA auf Netlify; Backend aus 28 Supabase Edge Functions (Deno);
Supabase Postgres mit 82 Tabellen; geplante Abrufe über pg_cron + pg_net;
zusätzlicher MCP-Server für KI-Clients mit eigenem OAuth-2.1-Server.

**Zugegriffene Amazon-Daten**
Reports API (16 Report-Typen, siehe 1.2), Finances API (`financialEvents`),
Catalog Items API (`dimensions`, `summaries`), Customer Feedback API
(Rezensionsthemen und -trends), Sellers API (`marketplaceParticipations`,
nur zur Credential-Prüfung). Getrennt davon die Amazon Ads API
(Berichte, Kampagnenstruktur, Gebote, Budgets, Profile).

**Gespeicherte Amazon-Daten**
Rohreports als JSONB in `report_data`; abgeleitet: Bestellpositionen, Retouren,
Abrechnungszeilen, Katalog/Maße, FBA-Bestand und -Historie, Bestandsalter,
Gebühren und Gebührenvorschau, Erstattungen, Bestands-Adjustments,
Suchbegriff-Performance, Rezensionsthemen. Ads-Daten in sieben Tabellen.
Aufbewahrung derzeit unbegrenzt.

**NICHT zugegriffene Amazon-Daten**
Keine Käufernamen, keine Käuferadressen, keine Käufer-Mailadressen, keine
Telefonnummern. Kein Orders-API-Aufruf mit `BuyerInfo` oder `ShippingAddress`,
kein `getOrderBuyerInfo`, keine Messaging-API, keine Solicitations-API, kein
Schreibzugriff auf Listings oder Bestellungen über die SP-API.
`ship-city`, `ship-state`, `ship-postal-code` werden vor dem Speichern verworfen
(`sync-report/index.ts:108`), ebenso `customer-comments` aus den FBA-Retouren
(`sync-report/index.ts:133`). Live in `report_data.payload.entfernteSpalten`
nachweisbar.

**Authentifizierungsmodell**
Endnutzer: Supabase-Auth mit E-Mail und Passwort, Session-JWT, `verify_jwt=true`
auf den API-Endpunkten. KI-Clients: Bearer-Token, serverseitig als SHA-256
verglichen, widerrufbar. Amazon: **kein OAuth-Flow** — Self-Authorization, der
Seller übergibt `client_id`, `client_secret` und `refresh_token`.
MFA: nicht vorhanden.

**Token-Speicherung**
Amazon-Credentials im Supabase Vault, je Tenant eigener Eintrag; in
`auth_contexts` steht nur die UUID-Referenz. Zugriff ausschließlich über zwei
`SECURITY DEFINER`-RPCs, die `anon` und `authenticated` entzogen und nur
`service_role` erteilt sind. MCP-Tokens nur als Hash. Rotation der
Amazon-Refresh-Tokens: nicht implementiert.

**Verschlüsselung**
Transport durchgehend TLS. Im Ruhezustand: Supabase Vault für Credentials
(oberhalb der Datenbankverschlüsselung). Alle übrigen Amazon-Daten liegen in
normalen Tabellen ohne zusätzliche Verschlüsselung.

**Mandantentrennung**
`tenant_id` in jeder Fachtabelle; Tenant wird aus der Identität abgeleitet, nie
aus dem Request-Body. RLS ist auf allen 82 Tabellen aktiv, aber nur 7 Policies
auf 5 Tabellen vorhanden; die Edge Functions arbeiten mit `service_role` und
umgehen RLS. Die Trennung wird damit im Anwendungscode durchgesetzt.
Plattform-Admins können bewusst auf jeden Mandanten wechseln.

**Datenlöschung**
Kein Pfad zum Trennen der Amazon-Verbindung. Kein Pfad zum Löschen von
Amazon-Daten oder Credentials. Keine Aufbewahrungsfrist implementiert.

**Protokollierung**
Vorhanden für Schreibzugriffe auf Amazon Ads (`ads_gebote_log`,
`ads_aenderungen_log` mit vorher/nachher), für OAuth-Ereignisse der MCP-Clients
(`oauth_ereignisse`), für Abrufjobs (`report_jobs`) und für eine KPI-Wache
(`kpi_wache_log`). Nicht vorhanden: Protokoll über Lesezugriffe auf Sellerdaten
und über Admin-Mandantenwechsel.

**Infrastruktur**
Frontend Netlify (Git-Deploy aus `main`). Backend Supabase Edge Functions,
ausgeliefert über GitHub Actions (`supabase functions deploy --use-api`).
Datenbank Supabase Postgres, EU-Region (SP-API-Endpunkt EU; Supabase-Region
**NOT VERIFIED**). Zeitsteuerung pg_cron, ausgehende Aufrufe pg_net.
Externe Dienste: Amazon SP-API, Amazon Ads API, Resend (Mail), Sellerboard
(CSV-Export). Helium 10 ist nicht angebunden.
Dasselbe Supabase-Projekt beherbergt ein zweites, unabhängiges Produkt.

**Sicherheitskontrollen**
Belegt vorhanden: TLS; JWT-Authentifizierung mit serverseitiger Tenant-Auflösung;
Admin-Prüfung vor Verbindungsaktionen; Token-Hashing; Vault-Isolation der
Credentials; PII-Filterung vor dem Speichern; ausgehendes Rate-Limiting gegen
Amazon mit 429-Wiederholung; Feature-Gating; tägliche Ausfallüberwachung per
Mail; Typprüfung und 900+ Unit-Tests in der CI vor jedem Deploy.
Belegt nicht vorhanden: MFA, Sicherheits-Header, Referrer-Policy, eingehendes
Rate-Limiting, WAF, Zugriffsprotokoll für Lesezugriffe, Löschmechanismus,
Amazon-OAuth-Flow, Token-Rotation.
**NOT VERIFIED:** Backup- und Wiederherstellungskonfiguration, Supabase-Region,
Brute-Force-Grenzen der Supabase-Auth, Inhalt der Laufzeit-Logs.

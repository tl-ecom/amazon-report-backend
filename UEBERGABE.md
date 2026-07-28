# Übergabe-Notiz — Amazon Report Backend

Stand (2026-07-18): sync-report holt vier Report-Typen (Sales & Traffic, Orders,
Listings, Returns), ein täglicher pg_cron-Job zieht sie automatisch, und ein
MCP-Server stellt sechs Tools für die KI bereit (Sales, Orders, Listings,
Product-Performance, Returns, Ads). Phase 2 (Ads) ist gebaut + unit-getestet;
End-to-End braucht noch Advertising-Credentials. Alles live und getestet (144 Unit-Tests).
Zum PRODUKTIV-Schalten fehlen nur drei manuelle Schritte — siehe `INBETRIEBNAHME.md`.
Dieses Dokument fasst zusammen, was gebaut ist und was als Nächstes ansteht.
Gedacht als Kontext-Briefing für Claude Code oder eine spätere Session.

---

## Was ist das?

Ein Multi-Tenant Supabase-Backend, das als Middleware zwischen Amazon SP-API und
(später) einer KI sitzt. Es holt Reports aus dem Amazon-Konto eines Sellers,
speichert sie, und stellt sie (perspektivisch über MCP) einer KI zur Verfügung.

**Geschäftsmodell:** Betreiber (ich) betreibt EIN zentrales Backend. Jeder Kunde
hat seine EIGENE Amazon self-authorized App (kein Public-App-Approval nötig) und
gibt seine Credentials, die verschlüsselt pro Tenant gespeichert werden.

**Auth-Modell (wichtig):** "Weg A" — jeder Kunde = eigene Amazon-App (self-auth).
Deshalb KEINE Public App nötig. Credentials liegen zentral, aber pro Tenant getrennt.

---

## Architektur

```
Amazon SP-API (pro Tenant eigene self-auth App)
   ↓  Refresh-Token → Access-Token (LWA)
Supabase Backend (dieses Projekt, EIN zentrales, multi-tenant)
   ├── Postgres: tenants, auth_contexts, report_jobs, report_data
   ├── Vault: Credentials verschlüsselt pro Tenant
   ├── RLS: Tenant-Isolation (Sicherheitsnetz; service_role umgeht sie,
   │        daher zusätzlich immer .eq('tenant_id', ...) im Code!)
   ├── pg_cron + pg_net: täglicher Auto-Sync pro Tenant (Schema `internal`)
   ├── Edge Functions:
   │     sync-report         ← SP-API-Report holen (request→poll→fetch)
   │     sync-ads-report     ← Advertising-Report holen (v3 async, source='ads')
   │     get-sales-overview  ← Sales-&-Traffic-Kennzahlen (EIN Marktplatz)
   │     get-orders-overview ← Orders-Kennzahlen (MEHRERE Kanäle!) — nicht
   │                            mit get-sales-overview vergleichen
   │     mcp                 ← MCP-Server für die KI (Bearer-Auth, stateless)
   │                            Tools: get_sales_overview, get_orders_overview,
   │                                   get_listings_overview, get_product_performance,
   │                                   get_returns_overview, get_ads_overview
   │     connect-sp          ← Seller verbindet SP-API (Self-Auth, validiert live)
   │     api                 ← Read-Endpunkt fürs Web-Frontend (Session-Auth)
   │     get-access-token    ← Diagnostik: prüft die Zugangsdaten
   │     request/check/fetch-report ← Einzelstufen, nur noch zum Debuggen
   └── _shared/  ← reine Module, unit-getestet, ohne DB/Netz
         metrics.ts    ← Sales-&-Traffic-Kennzahlen
         orders.ts     ← Orders-Kennzahlen
         listings.ts   ← Angebote/Bestand (Merchant vs FBA)
         product.ts    ← ASIN-Steckbrief (führt 3 Quellen zusammen, getrennt)
         returns.ts    ← Retouren (unvalidiert bis zum ersten echten Datensatz)
         ads.ts        ← Advertising-Kennzahlen (ACOS/ROAS); Phase 2
         ratelimit.ts  ← Wartezeiten aus Amazons Rate-Limit-Headern
         tsv.ts        ← Flat-File-Reports + Zeichensatz + PII-Filter
         mcp.ts        ← JSON-RPC-Dispatch + Tool-Registry (protokoll-stabil)
   ↓  LIVE
MCP-Server (Function `mcp`) → KI (ChatGPT/Claude) fragt aufbereitete Daten ab.
   Die Tools rechnen NICHT neu — sie nutzen die _shared/*-Module.
```

---

## Bewusst NICHT gebaut (häufige Rückfragen — das sind KEINE Lücken)

Diese zwei Punkte kamen wiederholt als vermeintliche Lücke hoch. Sie sind
Absicht, nicht vergessen:

1. **Keine eigenen `get-ads-overview` / `get-listings-overview` / `get-product-*`
   / `get-returns-*` REST-Functions.** NUR `get-sales-overview` und
   `get-orders-overview` existieren als eigene Function — das ist das ALTE Muster
   von vor dem `api`-Endpunkt. Seither werden ALLE Aufbereitungen (Ads, Listings,
   Product, Returns — und auch Sales/Orders) über **`api`** (Frontend, Session-Auth)
   und **`mcp`** (KI, Bearer) geliefert, beide via `rufeToolAuf`/`_shared/*`.
   → Das Ads-Dashboard ist über `api` mit `{resource:"get_ads_overview"}` bedient.
   Getestet. Es fehlt nichts.

2. **Kein OAuth-Code-Tausch (`spapi_oauth_code`), kein LWA-Callback-Handler.**
   Der Erst-Connect läuft über **Weg A** (Entscheidung 2026-07-18, zweimal
   bestätigt): der Seller bringt seinen SELBST erzeugten refresh_token mit.
   `connect-sp` IST der Erst-Connect-Handler — er validiert live und schreibt
   refresh_token + client-creds in den Vault + auth_contexts. Ein
   Authorization-Code-Tausch wäre **Weg B** und bräuchte eine zentrale, von Amazon
   genehmigte App (globale client_id/secret, registrierte Redirect-URI) — die es
   nicht gibt und die bewusst nicht gebaut wurde.

Falls einer dieser Punkte doch gebaut werden soll, ist es ein bewusster
Kurswechsel — nicht das Schließen einer vergessenen Lücke.

---

## Was funktioniert (getestet, in der Cloud live)

1. **Schema + RLS + Vault** — Migration 20260716000001
2. **read_vault_secret()** — SQL-Helper zum Entschlüsseln (Migration ...0002).
   WICHTIG: Direkter Vault-Zugriff aus Edge Functions über .schema('vault')
   war blockiert (500 "Vault-Werte konnten nicht gelesen werden"). Lösung war
   diese security-definer-Funktion + rpc-Aufruf. Nicht rückgängig machen.
3. **get-access-token** — Refresh→Access-Token. GETESTET: ok, Amazon akzeptiert.
   Läuft seit dem Aufräumen unter dem Slug `get-access-token`; der alte Slug
   `clever-worker` wurde gelöscht (siehe "Erledigt" unten).
4. **request-report** — fordert GET_SALES_AND_TRAFFIC_REPORT an (letzte 14 Tage).
   GETESTET: reportId erhalten.
5. **check-report** — Status abfragen. GETESTET: DONE + reportDocumentId.
6. **fetch-report** — Download + gzip entpacken + JSON + speichern.
   GETESTET: echte Daten in report_data. Struktur: reportSpecification,
   salesAndTrafficByDate, salesAndTrafficByAsin.
7. **sync-report** — verkettet alle drei Stufen zu EINEM Aufruf (siehe unten).
   Die drei Einzel-Functions bleiben als Debug-Werkzeug bestehen.
8. **_shared/metrics.ts + get-sales-overview** — deterministische Aufbereitung.
   Siehe eigenen Abschnitt unten.
9. **_shared/ratelimit.ts** — Wartezeiten aus Amazons Headern. Siehe unten.
10. **_shared/tsv.ts + Orders-Report** — Flat-File-Reports (TSV), Zeichensatz-
    Erkennung, PII-Filter beim Ingest. Siehe eigenen Abschnitt unten.
11. **_shared/orders.ts + get-orders-overview** — Orders-Kennzahlen. Siehe unten.
12. **_shared/mcp.ts + Function `mcp` + mcp_tokens** — MCP-Server für die KI.
    Bearer-Auth pro Tenant, stateless. Siehe eigenen Abschnitt unten.
13. **_shared/listings.ts + MCP-Tool get_listings_overview** — Angebote/Bestand,
    Snapshot-Report. Siehe eigenen Abschnitt unten. FBA-Bestand blockiert (Rolle).
14. **_shared/product.ts + MCP-Tool get_product_performance** — ASIN-Steckbrief
    über alle drei Quellen, bewusst OHNE Verschmelzung. Siehe eigenen Abschnitt.
15. **_shared/returns.ts + MCP-Tool get_returns_overview** — Retouren. Fertig,
    aber `unvalidiert` (Report war leer). Siehe eigenen Abschnitt.
16. **_shared/ads.ts + sync-ads-report + MCP-Tool get_ads_overview** — Phase 2,
    Advertising v3. Unit-getestet; End-to-End braucht Ads-Credentials. Siehe unten.

Tests: `npx deno@2 test supabase/functions/_shared/` → 144 Tests, alle grün.

Kompletter manueller Ablauf (3 Funktionen nacheinander) liefert echte Daten.
Seit sync-report reicht dafür ein einziger Aufruf.

---

## Wichtige Werte (KEINE Geheimnisse hier — die sind in Supabase/Passwort-Manager)

- Test-Tenant-ID: `62b44111-8088-493e-982c-e2c8d8452efa`
- Marketplace DE: `A1PA6795UKMFR9`
- Region/Endpoint: EU → `https://sellingpartnerapi-eu.amazon.com`
- LWA Token-Endpoint: `https://api.amazon.com/auth/o2/token`
- Report-API-Version: `2021-06-30`
- Amazon-App-Rollen angehakt: Markenanalyse, Lagerbestands-/Bestellverfolgung,
  Erkenntnisse zu Verkaufspartnern. PII-Delegation: Nein.

Geheimnisse (NICHT in dieses Repo!):
- Supabase Project-Ref, service_role key, anon key
- Amazon client_id, client_secret, refresh_token (liegen in Supabase Vault)

---

## Erledigt (2026-07-17)

- **Lokal mit Cloud synchronisiert.** Projekt ist gelinkt (Project-Ref
  `irvnghhxfjjnpodclfuc`, Region eu-west-2). Alle vier Functions heruntergeladen
  und abgeglichen: logisch identisch mit den lokalen Dateien. Abweichungen waren
  ausschließlich Kommentare/Formatierung plus zwei `hinweis`-Formulierungen in
  check-report. Lokale Dateien sind die Quelle der Wahrheit und wurden behalten.
- **clever-worker aufgeräumt.** Befund: `clever-worker` war KEIN Duplikat, sondern
  der echte Slug der live laufenden Function (Anzeigename get-access-token).
  Vorgehen: neu unter Slug `get-access-token` deployt → gegen Amazon getestet
  (HTTP 200, echter Token) → erst dann `clever-worker` gelöscht (jetzt 404).
  Nichts hing daran: die drei Report-Functions tauschen ihren Token je selbst
  über eine eigene `getAccessToken`-Hilfsfunktion. get-access-token ist reine
  Diagnostik.

## sync-report — die verkettete Function (fertig + getestet)

Ein Aufruf macht: anfordern → pollen mit Backoff → abholen → speichern.

```
POST /functions/v1/sync-report
Body: { "tenant_id": "...", "report_id"?: "...", "report_type"?: "...",
        "days"?: 14, "include_volatile"?: false }
```

**Zeitbudget statt Timeout (wichtig zu verstehen):** Edge Functions haben ein
Wall-Clock-Limit (~150s), ein Amazon-Report braucht aber oft 1-5 Min. Deshalb
pollt sync-report nur bis 90s (POLL_BUDGET_MS) und gibt danach BEWUSST
`{status:"PROCESSING", report_id}` mit HTTP 200 zurück — das ist KEIN Fehler.
Derselbe Aufruf mit `report_id` nimmt den Faden wieder auf, fordert NICHTS neu an
und holt direkt ab. So kann die Function nie ins Timeout laufen.
(Tritt real auf: ein 30-Tage-Report brauchte 68s, ein anderer lief ins Budget.)

**ZEITFENSTER — der wichtigste Befund bisher.** Amazons Traffic-Daten hinken
~2 Tage nach, die Bestelldaten NICHT. Ein Fenster bis "heute" enthält deshalb
Bestellungen ohne zugehörige Sessions → die CVR ist systematisch zu hoch, und
salesAndTrafficByDate und ...ByAsin widersprechen sich.

Nachgewiesen am 2026-07-17 am echten Konto:
- Fenster bis heute: byAsin = 2 Units / 15,90 EUR, byDate = 1 Unit / 8,05 EUR.
  byDate brach 2 Tage vor dem Spec-Ende ab, byAsin summierte trotzdem weiter.
  Sessions stimmten dabei exakt überein (55 = 55) — nur die Verkäufe divergierten.
- Stabiles Fenster (Ende = heute-2): byDate deckt das Spec-Fenster exakt ab,
  und sessions/units/umsatz stimmen zwischen beiden Granularitäten überein.

Konsequenz: `stableLagDays: 2` in REPORT_KONFIG für Sales & Traffic — das
Default-Fenster endet 2 Tage vor heute. `include_volatile:true` geht bis heute
und setzt dann `is_provisional=true`.
ACHTUNG: Das gilt NUR für Sales & Traffic. Der Nachlauf betrifft den Traffic;
Orders haben `stableLagDays: 0`. Nicht pauschal auf neue Report-Typen übertragen.
Bei Wiederaufnahme werden report_type und include_volatile aus report_jobs.config
gelesen, NICHT aus dem Body — sonst landen die Daten falsch gekennzeichnet.

Antworten:
- `{ok:true, status:"DONE", ...}` — durchgelaufen, Daten liegen in report_data
- `{ok:true, status:"PROCESSING", report_id}` — Budget aufgebraucht, erneut mit report_id aufrufen
- `{ok:false, status:"FATAL"|"CANCELLED"}` — Amazon konnte nicht liefern (CANCELLED = meist keine Daten im Zeitraum)

Backoff beim Polling: 5s → ×1.5 → max 30s.

**Getestet am 2026-07-17 gegen das echte Konto:**
- Kompletter Ablauf in einem Aufruf: 27s, DONE, 13 Tage + 4 ASINs in report_data
- Wiederaufnahme mit report_id: 2s (fordert nachweislich nicht neu an)
- Fremde report_id → 404 (Tenant-Schutz greift, obwohl service_role RLS umgeht)
- tenant_id fehlt → 400; days=500 → 400
- report_jobs bekommt config/data_timestamp/completed_at gefüllt
- Invariante geprüft: weiterhin genau EINE is_latest-Zeile

**Fallstrick für später:** Der Unique-Index `one_latest_per_report` erlaubt nur
EINE Zeile mit is_latest je (tenant, source, report_type). Deshalb MUSS erst
is_latest=false gesetzt und dann eingefügt werden — andere Reihenfolge = Insert
kollidiert. Gilt für jeden neuen Report-Typ.

---

## Deterministische Aufbereitung (fertig + getestet)

**`supabase/functions/_shared/metrics.ts`** — reines Rechenmodul, keine DB, kein
Netz. Damit unit-testbar und später vom MCP-Server direkt nutzbar (Punkt 5 unten),
ohne die Logik zu duplizieren.

**`get-sales-overview`** — macht nur I/O: liest die is_latest-Zeile aus report_data
und lässt metrics.ts rechnen. Rechnet bei jedem Aufruf frisch aus dem Payload,
statt Kennzahlen zu speichern — so können sie nie von report_data abweichen.

```
POST /functions/v1/get-sales-overview
Body: { "tenant_id": "...", "report_type"?: "GET_SALES_AND_TRAFFIC_REPORT" }
```

Liefert: zeitraum, data_timestamp, is_provisional, gesamt, proAsin (nach Umsatz
sortiert), konsistenz, formeln. Die Formeln gehen bewusst mit raus, damit
nachvollziehbar ist, wie gerechnet wurde.

**Umgesetzte Regeln:**
- Rohwerte summieren, nie Amazons %-Spalten. CVR = Σ units / Σ sessions.
- Geld wird in ganzen CENT summiert (0.1 + 0.2 driftet sonst auf 0.30000000000000004).
- Nenner 0 → `null`, nicht 0/NaN/Infinity. "Keine Aussage" ≠ "null Prozent".
- Gemischte Währungen → Fehler 422 statt stumm addieren.
- byDate vs. byAsin wird verglichen und Divergenz ausgewiesen, nicht gemittelt.

**Tests:** 16 Tests für metrics.ts.
WICHTIG, warum synthetische Fixtures: Das Testkonto hat fast keine Verkäufe, und
bei lauter Nullen liefern die richtige und die falsche Rechenweise dasselbe
Ergebnis — der Bug wäre an echten Daten unsichtbar. Zusätzlich per Mutationstest
geprüft: baut man den %-Mittelwert-Bug absichtlich ein, schlagen 2 Tests fehl.

**Beleg für den Operator-Ansatz (am echten Konto):** Am 18.06. steht in den
Rohwerten unitsShipped=1 und unitsRefunded=1 — Amazons eigene `refundRate`-Spalte
meldet für JEDEN Tag 0. Amazons fertige Prozentspalten widersprechen also ihren
eigenen Rohdaten. Nicht auf sie verlassen.

**Aktueller Stand des Testkontos** (damit die Zahlen niemanden erschrecken):
31 Tage, 59 Sessions, genau 1 Verkauf (8,05 EUR), der retourniert wurde.
Retourenquote 100 % ist bei n=1 korrekt gerechnet, aber statistisch bedeutungslos.
Die Rohwerte gehen mit raus, damit man n sieht.

---

## Rate-Limits (fertig + getestet)

**`supabase/functions/_shared/ratelimit.ts`** — reines Modul: Header rein,
Wartezeit in ms raus. 13 Unit-Tests.

**Die Falle:** `x-amzn-RateLimit-Limit` ist eine RATE in Requests pro SEKUNDE,
KEINE Wartezeit. Amazon schickt `0.0167` → das sind ~60s Abstand (1 / 0.0167),
nicht 17 Millisekunden. Wer den Wert als Sekunden liest, wartet praktisch gar
nicht und läuft sofort ins nächste 429.

Reihenfolge der Autorität bei 429:
1. `Retry-After` (Sekunden ODER HTTP-Datum) — Amazon sagt es explizit
2. `x-amzn-RateLimit-Limit` → Abstand = 1 / Rate
3. dokumentierter Standard je Operation (Amazon schickt bei 429 nicht zuverlässig
   einen Header mit)
Ergebnis wird auf 1s..60s begrenzt und zusätzlich gegen das Zeitbudget geprüft.

**Am echten Konto beobachtet (2026-07-17)** — die Header werden auch bei
erfolgreichen Antworten geschickt, `sync-report` gibt sie als
`rate_limits_beobachtet` mit aus:

| Operation         | Rate       | Abstand |
|-------------------|------------|---------|
| createReport      | 0.0167 rps | ~60 s   |
| getReport         | 2.0 rps    | 0,5 s   |
| getReportDocument | 0.0167 rps | ~60 s   |

Das deckt sich exakt mit den Fallback-Konstanten in `STANDARD_RATEN`. Laut Amazon
können die Limits je Verkäufer abweichen — deshalb wird der Header gelesen und
nicht fest verdrahtet.

Daraus folgt: Das Polling (getReport, 2 rps) hat mit 5s Startintervall reichlich
Luft. Eng sind createReport und getReportDocument mit je ~1 Aufruf pro Minute —
relevant, sobald der Scheduler mehrere Tenants nacheinander zieht.

**Nicht getestet:** der 429-Pfad end-to-end. Ein echtes 429 zu provozieren hieße,
die API des Verkäufers absichtlich zu überfahren (Burst-Kontingent leerlaufen
lassen) — das wurde bewusst unterlassen. Die Wartezeit-Berechnung ist per Unit-Test
abgedeckt, die Verdrahtung nicht gegen ein echtes 429 verifiziert.

**Nebenbei behoben:** `fetchDocument` hatte vorher GAR KEINE 429-Behandlung,
obwohl getReportDocument zu den strengsten Limits gehört.

---

## Orders-Report / TSV (fertig + getestet)

`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` läuft über dieselbe Function:

```
POST /functions/v1/sync-report
Body: { "tenant_id": "...", "report_type": "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL", "days": 30 }
```

**Report-Typen sind jetzt konfiguriert, nicht verdrahtet** (`REPORT_KONFIG` in
sync-report). Je Typ: `format`, `reportOptions`, `stableLagDays`, `piiSpalten`,
`maxDays`, `pflichtSchluessel`.
Vorher gingen Sales-&-Traffic-Optionen an JEDEN Report — der Orders-Report kennt
`dateGranularity`/`asinGranularity` nicht. Unbekannte Typen: `format: "auto"`
(erst JSON, sonst TSV), keine reportOptions, maxDays 30 (vorsichtiger Default).

**`stableLagDays` ist typabhängig:** Sales & Traffic 2 (Traffic-Nachlauf),
Orders 0. Der Nachlauf betrifft den TRAFFIC — Orders haben keinen. Bei Orders
2 Tage abzuziehen wäre grundloser Datenverlust.

**`_shared/tsv.ts`** — Zeichensatz ist die unangenehme Stelle: Amazons Flat Files
sind für EU historisch Windows-1252, nicht UTF-8, und getReportDocument sagt es
einem nicht. Vorgehen: UTF-8 mit `fatal:true` versuchen, bei Fehlschlag
Windows-1252. Deterministisch, kein Raten an Ersatzzeichen.
WICHTIG: In sync-report werden bewusst BYTES durchgereicht — `.text()` dekodiert
hart als UTF-8 und macht aus Umlauten unwiederbringlich U+FFFD.
(Der real geholte Report war UTF-8; der Windows-1252-Pfad ist unit-getestet,
aber noch nie an einem echten Amazon-Flat-File ausgelöst worden.)

**DSGVO — Datenminimierung beim Ingest.** Der Report enthält Standortdaten der
Endkunden. `ship-city`, `ship-state`, `ship-postal-code` werden VOR dem Speichern
verworfen (`piiSpalten`), `ship-country` bleibt (für Kanal-/Marktplatzzuordnung
nötig, nicht personenbeziehbar). Was nie gespeichert wird, braucht keine
Löschfrist und keine AVV-Abdeckung. Die Entfernung wird im Payload unter
`entfernteSpalten` dokumentiert, damit später niemand rätselt, warum ein Feld
aus Amazons Report fehlt. Bei 4 echten Bestellungen verifiziert: 35 → 32 Spalten,
keine Ortsnamen/PLZ mehr im gespeicherten JSON.

### Amazon liefert Fehler ALS Report-Inhalt (wichtigster Fallstrick überhaupt)

Am 2026-07-17 aufgetreten: Ein Orders-Report über 90 Tage kam mit
`processingStatus: DONE` und HTTP 200 zurück — der Dokument-INHALT war aber:

```
Date range exceeded. Report can be requested only upto 30 days
```

Kein HTTP-Fehler, kein FATAL, kein CANCELLED. sync-report hat das brav als TSV
geparst (eine Spalte, null Zeilen), die guten Daten auf `is_latest=false` gesetzt
und die Fehlermeldung als aktuellen Datensatz gespeichert. Nach außen: `DONE`,
HTTP 200. Eine lautlose Datenregression — auf einem Scheduler hätte das gute
Daten durch eine Fehlermeldung ersetzt, ohne dass irgendwo etwas aufgefallen wäre.

Zwei Schutzschichten, beide am echten Konto verifiziert:

1. **`maxDays` je Report-Typ** (Orders 30, Sales & Traffic 90). Wird vorab geprüft
   → HTTP 400, bevor Amazon überhaupt gefragt wird.
2. **`pruefePayload()` VOR dem Speichern.** Reihenfolge ist entscheidend: erst
   prüfen, dann `is_latest` anfassen. Sonst steht die DB im Fehlerfall ganz ohne
   aktuellen Datensatz da. Erkennungsregel für Flat Files: ein echtes hat mehrere
   tab-getrennte Spalten — eine Fehlermeldung ergibt genau "eine Spalte". Für
   JSON-Reports: `pflichtSchluessel` (bei Sales & Traffic `reportSpecification`).

Schicht 2 ist Verteidigung in der Tiefe: Schicht 1 verhindert genau diesen einen
bekannten Fall, Schicht 2 fängt die noch unbekannten. Der Unit-Test dazu benutzt
Amazons echten Meldungstext.

**Lehre für neue Report-Typen:** `processingStatus: DONE` heißt NICHT, dass
verwertbare Daten kamen. Immer prüfen, bevor gespeichert wird.

### Drei weitere Fallstricke bei diesen Daten (am echten Konto beobachtet)

1. **Orders und Sales & Traffic sind NICHT vergleichbar.** Der Orders-Report
   liefert Bestellungen aus `Amazon.de`, `Amazon.com.be` UND `Non-Amazon` (MCF).
   Sales & Traffic ist auf `marketplaceIds: [A1PA6795UKMFR9]` beschränkt. Real
   beobachtet: die ASINs B09JSHP49L und B0DW43MJC9 tauchen in Orders auf, in
   Sales & Traffic überhaupt nicht. Umsätze der beiden Reports NIE gegeneinander
   rechnen, ohne vorher auf `sales-channel` zu filtern.
2. **MCF-Bestellungen haben keinen Preis.** Bei `sales-channel = Non-Amazon` sind
   `currency` und `item-price` LEER (nicht 0). Wer `item-price` naiv summiert,
   bekommt stillschweigend zu wenig Umsatz. Leere Felder ≠ null Euro.
3. **Frische Bestellungen sind volatil.** `order-status: Pending` kommt real vor;
   Status und Preise ändern sich noch. `last-updated-date` beachten.

---

## Orders-Aufbereitung (fertig + getestet)

**`_shared/orders.ts`** + **`get-orders-overview`** — bewusst NICHT dieselbe
Function wie get-sales-overview und keine Kopie von metrics.ts: die Reports haben
verschiedene Zuschnitte und verschiedene Fallstricke. Ein gemeinsamer Endpunkt
würde nahelegen, dass man die Zahlen vergleichen darf. Darf man nicht.

```
POST /functions/v1/get-orders-overview
Body: { "tenant_id": "..." }
```

Liefert: zeitraum, gesamt, proKanal, proStatus, proAsin, warnungen, formeln.

### Die vier Regeln, die hier gelten

1. **Zeilen sind POSITIONEN, keine Bestellungen.** `amazon-order-id` wiederholt
   sich bei Bestellungen mit mehreren SKUs. Bestellungen = distinct order-id,
   NICHT rowCount.
2. **Leerer Preis = unbekannt, NICHT 0.** MCF-Zeilen (`sales-channel: Non-Amazon`)
   haben keinen Preis. Als 0 gezählt würde stillschweigend Umsatz fehlen.
3. **"Nichts verkauft" ≠ "Preis unbekannt".** Hat eine Gruppe (Kanal/ASIN)
   Positionen, aber KEINE davon einen Preis, ist ihr Umsatz `null` — nicht 0.
   `umsatz: 0` würde behaupten, dort sei nichts umgesetzt worden. Nur bei GAR
   keinen Positionen ist 0 richtig. Hat wenigstens eine Position einen Preis, ist
   die Summe eine echte Untergrenze und wird ausgegeben (mit
   `umsatzVollstaendig: false`).
   Dieser Fehler war real drin und ist erst am echten Datensatz aufgefallen:
   der Kanal Non-Amazon meldete "umsatz: 0" statt "unbekannt".
4. **Immer nach Kanal aufschlüsseln.** Amazon.de, Amazon.com.be und Non-Amazon
   liegen im selben Report. Undifferenziert summiert ist die Zahl mit nichts
   vergleichbar.

### item-price: Semantik weiterhin ungeklärt — bewusst

Ist `item-price` der Stückpreis oder die Zeilensumme (quantity schon drin)?
Am Testkonto NICHT entscheidbar: alle bepreisten Zeilen haben `quantity = 1`,
und ein längerer Report geht wegen des 30-Tage-Limits nicht.

Gelöst über empirische Klärung statt Raten: orders.ts rechnet BEIDE Lesarten.
- Solange sie übereinstimmen (= alle bepreisten Zeilen haben quantity 1), ist der
  Umsatz eindeutig und wird als `umsatz` ausgegeben. **Das ist der heutige Zustand.**
- Sobald eine bepreiste Zeile mit `quantity > 1` auftaucht, driften sie
  auseinander → `umsatz: null` und eine Warnung mit beiden Zahlen. Dieser erste
  Datensatz beantwortet die Frage endgültig.

**Wenn diese Warnung erscheint:** einmal in Seller Central gegenprüfen, welche
Lesart stimmt, dann in orders.ts festschreiben und die Doppelrechnung entfernen.

### Am echten Konto (2026-07-17)

4 Bestellungen, 13 Einheiten, davon 11 ohne bekannten Preis:

| Kanal         | Einheiten | Umsatz    |
|---------------|-----------|-----------|
| Non-Amazon    | 11        | unbekannt |
| Amazon.de     | 1         | 7,85 EUR  |
| Amazon.com.be | 1         | 18,04 EUR |

Ausgewiesener Gesamtumsatz 25,89 EUR mit `umsatzVollstaendig: false` — 11 von 13
Einheiten haben keinen bekannten Preis. Die Zahl ist eine Untergrenze, keine
Aussage über den tatsächlichen Umsatz.

---

---

## Scheduler / pg_cron (installiert — EIN manueller Schritt fehlt noch)

Migration `20260717000003_scheduler.sql`. Zwei Cron-Jobs, live und aktiv:

| Job | Zeitplan | Zweck |
|-----|----------|-------|
| `sync-alle-tenants-taeglich` | `30 4 * * *` (04:30 UTC) | stößt pro Tenant × Report-Typ EINEN sync-report-Aufruf an |
| `resume-offene-reports` | `*/15 * * * *` | fasst PROCESSING-Reports nach (report_id-Pfad, fordert nichts neu an) |

**Läuft NOCH NICHT wirklich — zwei Vault-Secrets fehlen.** Das ist Absicht: der
`service_role_key` gehört nicht in eine Repo-Migration und nicht im Klartext in
ein geloggtes Kommando. Ohne die Secrets wirft `internal.stosse_sync_an()` eine
Exception (abgefangen → warning), es geht KEIN HTTP-Request raus. Verifiziert:
die Jobs liefen mehrfach, ohne irgendetwas anzustoßen.

**EINMALIG von Hand einzurichten** (Supabase Dashboard → SQL Editor):

```sql
select vault.create_secret(
  'https://irvnghhxfjjnpodclfuc.supabase.co', 'project_url', 'Basis-URL für Cron→Edge-Function-Aufrufe');
select vault.create_secret(
  'DEIN_SERVICE_ROLE_KEY', 'service_role_key', 'service_role für Cron→sync-report');
```

Danach prüfen mit (gibt NUR ob/nicht die Werte zurück):
```
POST /rest/v1/rpc/scheduler_status   (mit service_role key)
```
`secrets_vorhanden` muss dann für beide `true` zeigen. Ab dem nächsten 04:30-Lauf
zieht der Scheduler automatisch. Sofort testen geht mit
`select internal.cron_sync_alle_tenants();` im SQL Editor.

**Designentscheidungen (stehen ausführlich im Migrations-Kopf):**
- Jeder Tenant = eigener pg_net-HTTP-Request. Ein toter Token bei A blockiert B
  nicht — die Requests wissen nichts voneinander. Eine Sammel-Edge-Function würde
  am Wall-Clock-Limit sterben (90s × N Tenants).
- Rate-Limits unkritisch tenant-übergreifend: jeder Kunde hat eigene Amazon-App +
  eigenes Verkäuferkonto ("Weg A"), Limits gelten pro App+Verkäufer.
- Nur `status='connected'` (auth_contexts) und `status='active'` (tenants) werden
  gezogen. revoked/error/paused/offboarded fallen automatisch raus.
- PROCESSING-Jobs älter als 6h werden als FATAL aufgegeben, sonst ewige Retries.
- Alles in Schema `internal` (nicht über PostgREST erreichbar). Nur die
  Diagnose-Funktion `public.scheduler_status()` ist von außen aufrufbar
  (service_role), und die gibt Secrets nur als true/false zurück, nie im Klartext.
- Report-Typen des täglichen Laufs stehen in `internal.scheduler_reports` — dort
  ein-/ausschalten oder days ändern, kein Code-Deploy nötig.

**Migrationshistorie:** Die ersten beiden Migrationen wurden am 2026-07-17 per
`supabase migration repair --status applied` als angewendet markiert (das SQL war
ursprünglich von Hand in der Cloud ausgeführt worden, die Historie war leer).
Seither ist `supabase db push` der normale Weg. `db dump`/`db diff` brauchen
Docker (hier nicht vorhanden) — `db push` und `migration list` nicht.

---

---

## MCP-Server (fertig + getestet) — das Backend ist jetzt END-TO-END nutzbar

Eine KI (ChatGPT/Claude) kann sich verbinden und die aufbereiteten Kennzahlen als
Tools abrufen. Damit erfüllt das Backend zum ersten Mal seinen eigentlichen Zweck.

```
POST /functions/v1/mcp
Authorization: Bearer <mcp-token>
Body: JSON-RPC 2.0
```

**Tools:** `get_sales_overview`, `get_orders_overview`, `get_listings_overview`,
`get_product_performance`,
`get_returns_overview`, `get_ads_overview`. Sie rechnen NICHT neu —
sie rufen `_shared/metrics.ts` bzw. `_shared/orders.ts` (dieselbe getestete Logik
wie die get-*-overview-Functions). Ergebnis kommt als JSON-Text UND als
`structuredContent`.

**Stateless mit Absicht.** Kein initialize-Zwang, keine Session-ID. Die MCP-Spec
geht genau dorthin (Release Candidate 2026-07-28 entfernt Session-IDs), und Edge
Functions sind pro Aufruf zustandslos. `_shared/mcp.ts` ist der protokoll-stabile
Kern (JSON-RPC-Dispatch, Tool-Registry) und unit-getestet; der DB-Zugriff wird als
`ladeReport` injiziert, damit das Modul netzfrei testbar bleibt.

**Auth (mcp_tokens, Migration ...0004):** Bearer-Token pro Tenant.
- In der DB liegt NUR der SHA-256-Hash, nie der Klartext. Der MCP-Server hasht den
  eingehenden Token selbst — der Klartext erreicht die DB nie.
- RLS an, KEINE Policies → nur service_role kommt an die Tabelle.
- Die tenant_id kommt AUSSCHLIESSLICH aus dem Token, nie aus dem Request-Body.
- `verify_jwt = false` für diese Function (MCP-Clients schicken keinen
  Supabase-JWT); die Auth macht die Function selbst.

**Am echten Konto getestet (2026-07-17):**
- initialize / notifications(202) / tools/list / tools/call — alles ok
- get_sales_overview: 187 Sessions, 150,05 EUR, CVR 4,81 %
- get_orders_overview: 4 Bestellungen, Warnungen inkl. Kanal-Hinweis
- Kein Token → 401, falscher → 401, widerrufener → 401, GET → 405
- Fremde tenant_id im Body → wirkungslos (Tenant kommt aus dem Token)

### Einen MCP-Token für einen Tenant ausstellen

Es gibt bewusst KEINE Funktion, die den Klartext-Token über die Leitung schickt.
Der Betreiber erzeugt ihn lokal, speichert nur den Hash:

```bash
TOKEN="mcp_$(python -c 'import secrets;print(secrets.token_hex(24))')"
HASH=$(python -c "import hashlib;print(hashlib.sha256('$TOKEN'.encode()).hexdigest())")
# TOKEN dem Kunden geben (einmalig!), HASH in die DB:
#   insert into mcp_tokens (tenant_id, token_hash, name) values ('<tenant>', '<HASH>', '<name>');
```

Übersicht ohne Hash/Klartext: `select public.mcp_tokens_uebersicht('<tenant>');`
Widerrufen: `update mcp_tokens set revoked = true where id = '<id>';`

**Anbindung an einen echten KI-Client** (offen, vom Betreiber zu machen): Den
Endpunkt als Custom Connector / Remote-MCP eintragen, Bearer-Token hinterlegen.
Ob ein bestimmter Client zusätzlich OAuth erwartet, ist clientabhängig und hier
noch nicht erprobt — der Server selbst ist per Bearer testbar (siehe oben).

---

---

## Listings-Report + FBA-Bestand (2026-07-17)

### Snapshot-Reports (ohne Zeitraum) — neu in sync-report

Manche Reports sind Momentaufnahmen ohne dataStartTime/dataEndTime (aktueller
Bestand, aktuelle Angebote). REPORT_KONFIG kennt dafür `snapshot: true` — dann
wird KEIN Zeitraum gesendet und die days-Prüfung übersprungen. Erster Vertreter:
Listings.

### GET_MERCHANT_LISTINGS_ALL_DATA — läuft, als MCP-Tool `get_listings_overview`

`_shared/listings.ts` (unit-getestet) + Tool im MCP-Server. Am echten Konto:
1616 Angebote (475 aktiv, 1106 inaktiv, 35 unvollständig), Preisspanne 2,20–183,01.

**Bewusste Entscheidung: KEINE eigene get-listings-overview REST-Function.** Der
MCP-Server ist jetzt der Konsument der aufbereiteten Daten; neue Reports kommen
nur noch als MCP-Tool. Testbar bleibt es per curl gegen die mcp-Function (Bearer).
Die älteren get-sales-overview / get-orders-overview bleiben bestehen, werden aber
nicht mehr das Standardmuster für Neues.

**FALLSTRICK (belegt), analog zum leeren Preis bei Orders:** `quantity` bedeutet
je `fulfillment-channel` etwas anderes.
- DEFAULT (Merchant): quantity ist der ECHTE Bestand. quantity=0 bei AKTIVEM
  Angebot = Out-of-Stock (kann nichts verkaufen). DAS ist die wertvolle Kennzahl.
- AMAZON_* (FBA): quantity ist LEER — der Bestand liegt im FBA-Report. Leer heißt
  "hier nicht geführt", NICHT 0. FBA-Angebote werden NIE als ausverkauft gewertet.
Real: alle 4 aktiven FBA-Angebote haben leere quantity, alle 471 Merchant-Angebote
haben quantity > 0. Aktuell 0 ausverkauft.

Der Report hat KEINE Währungsspalte — `price` ist eine nackte Zahl, Währung ergibt
sich aus dem Marketplace (DE=EUR). Wird als Zahl ohne Währungsbehauptung ausgegeben.

### FBA-Lagerbestand — blockiert durch fehlende App-Rolle

GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA wurde versucht. Amazon antwortete schon
beim Anfordern mit `Unauthorized / Access to the resource is forbidden`. Diagnose
gehärtet: der Listings-Report (andere Rolle) lief gleichzeitig einwandfrei, also
KEIN systematisches Rechteproblem — dieser Report braucht speziell die App-Rolle
**"Amazon Fulfillment"**, die beim Test-Seller nicht angehakt ist (nur
Markenanalyse, Lagerbestands-/Bestellverfolgung, Verkaufspartner-Insights).

Der REPORT_KONFIG-Eintrag bleibt bewusst stehen (mit Kommentar): Sobald die Rolle
angehakt UND die App neu autorisiert ist (→ neuer Refresh-Token in den Vault),
läuft der Report OHNE Code-Änderung. Bis dahin ist der Merchant-Bestand über
Listings abgedeckt, nur der FBA-Lagerbestand fehlt.

**Der fehlgeschlagene Aufruf hinterließ keinen Müll** — der SP-API-Fehler kommt
vor dem report_jobs-Insert, verifiziert.

---

---

## get_product_performance — ASIN-Steckbrief über alle drei Quellen (fertig + getestet)

`_shared/product.ts` (unit-getestet) + MCP-Tool `get_product_performance`.
Optional `asin` (ein Produkt) oder `limit`; ohne Argument alle ASINs mit
Traffic ODER Verkauf.

**ZENTRALER GRUNDSATZ — die Quellen werden NICHT verschmolzen.** Am echten Konto
belegt: die drei Reports sind nicht deckungsgleich.
- Sales & Traffic: EIN Marktplatz (DE), SEIN Zeitraum (hier 91 Tage).
- Orders: MEHRERE Kanäle (Amazon.de, .com.be, Non-Amazon), ANDERER Zeitraum (30 Tage).
- Listings: Momentaufnahme.
Real: von 3 Orders-ASINs waren 2 NUR in Orders (Fremdkanäle), nur 1 ASIN in allen
drei. Ein "Gesamtumsatz je ASIN" wäre schlicht falsch (verschiedene Zeiträume +
Kanäle). Deshalb: pro ASIN jede Quelle SEPARAT mit Herkunft/Zeitraum/Kanal, plus
eine explizite Warnung. KEINE quellenübergreifende Summe.

**Deterministische Hinweise** (Regeln, kein LLM), am echten Konto ausgelöst:
- "81 Sessions ohne einen einzigen Verkauf" → Conversion-Problem
- "Bestellungen, aber nicht in S&T" → nur über Fremdkanäle verkauft
- "Traffic, aber kein aktives Angebot" → verlorene Sichtbarkeit
- Out-of-Stock (aktives Merchant-Angebot, Bestand 0)
- "Enthält FBA-Angebote — Bestand hier nicht sichtbar"

**Fallstricke, die das Modul beachtet:** ein ASIN kann mehrere Listings haben
(aggregiert), Orders-Umsatz ist null statt 0 wenn alle Positionen preislos (MCF),
Merchant-Bestand summiert nur DEFAULT-Angebote (FBA führt Bestand nicht hier).

---

---

## get_returns_overview — Retouren (fertig, ABER unvalidiert)

`_shared/returns.ts` (unit-getestet) + MCP-Tool `get_returns_overview`.
Merchant-Retouren nach Antragsdatum: Anzahl, Einheiten, erstattete Beträge,
gruppiert nach Grund/Resolution/Status/ASIN. In sync-report konfiguriert (tsv,
maxDays 30, kein PII-Filter nötig — keine ship-*-Spalten) und im Scheduler.

**WICHTIG — ehrliche Validierungslücke:** Der echte Report war bei Erstellung
LEER (0 Retouren im Testzeitraum). Die 35 Spaltennamen sind bekannt und
selbsterklärend, aber die WERT-Formate sind nicht an echten Daten geprüft.
Deshalb:
- String-Gruppierungen (Grund/Resolution/Status/ASIN) sind formatsicher.
- Geldfelder (Refunded Amount) werden tolerant geparst (Währungssymbol, Komma-
  Dezimaltrenner), unlesbar → null (nicht 0).
- Datumsfelder werden als String durchgereicht, NICHT geparst.
- Der Output trägt `unvalidiert: true` und eine Warnung.

**Beim ERSTEN echten Retouren-Datensatz zu tun:** Refunded-Amount-Format
gegenprüfen (Zeilensumme vs. Stück? Dezimaltrenner?), dann `unvalidiert` entfernen.

Die **Retourenquote** (Retouren / verkaufte Einheiten) fehlt bewusst — der Nenner
kommt aus Sales/Orders, das ist ein Cross-Report-Schritt (analog product.ts).

Der Scheduler zieht jetzt VIER Typen: Sales & Traffic, Orders, Listings, Returns.

---

---

## PHASE 2 — Ads-API (gebaut + unit-getestet, End-to-End braucht Ads-Credentials)

Amazon Advertising API v3 (Sponsored Products). Eigene Function `sync-ads-report`,
Modul `_shared/ads.ts`, MCP-Tool `get_ads_overview`. Alles mit `source='ads'` —
das Schema war dafür von Anfang an vorbereitet (auth_contexts/report_jobs/
report_data haben `source in ('sp','ads')`, auth_contexts hat `profile_id`).

**Ablauf (v3 async, verifiziert gegen die aktuelle Spec):**
1. Ads-Auth: refresh_token → access_token (LWA), dann Profil-Header
   (Amazon-Advertising-API-ClientId + -Scope=profile_id).
2. POST /reporting/reports (Content-Type application/vnd.createasyncreportrequest.v3+json),
   adProduct SPONSORED_PRODUCTS, reportTypeId spAdvertisedProduct, GZIP_JSON.
3. Poll bis COMPLETED (mit Zeitbudget + Wiederaufnahme wie sync-report).
4. Download gzip JSON → speichern.

**Kennzahlen (ads.ts, deterministisch aus Rohwerten):** Impressions, Klicks,
Spend, Sales, ACOS (Spend/Sales — die zentrale Kennzahl), ROAS, CTR, CVR, CPC —
je Kampagne und ASIN. Nenner 0 → null (ACOS bei Sales 0 ist null, NICHT 0). Geld
in Cent summiert.

**is_provisional / 72h-Regel:** Ads-Zahlen der letzten ~3 Tage werden von Amazon
noch angepasst (Klickbetrug-Filter, verspätete Attribution). Standard-Fenster
endet 3 Tage vor heute (stabil); `include_volatile:true` geht bis gestern und
setzt `is_provisional=true`.

**Endpoint EU:** `https://advertising-api-eu.amazon.com`.

**GETESTET (was ohne Credentials geht):**
- `_shared/ads.ts`: 15 Unit-Tests (ACOS/ROAS/CTR/CVR/CPC, Nenner-0, 72h-Regel,
  Geld-Drift, Gruppierung).
- sync-ads-report ohne ads-auth_context → sauberer 404 (kein Crash), verifiziert.
- get_ads_overview live, liefert korrekt "keine Daten" bis ein Report da ist.

**NICHT getestet (Testgrenze, ehrlich):** der echte Ads-API-Aufruf. Dafür fehlen
die Advertising-Credentials im Vault. Die exakten Spaltennamen des
spAdvertisedProduct-v3-Reports (cost, sales7d, purchases7d, unitsSoldClicks7d)
sind aus der Spec, aber nicht an echten Daten verifiziert — beim ersten echten
Lauf gegenprüfen.

### Ads-auth_context anlegen (damit End-to-End läuft)

Voraussetzung: eine Amazon-**Advertising**-App (getrennt von der SP-API-App) mit
eigener client_id/secret/refresh_token, und die profileId des Werbekontos
(über GET /v2/profiles am Ads-Endpoint abrufbar). Dann:

```sql
-- drei Secrets in den Vault (Klartext ersetzen):
select vault.create_secret('<ADS_CLIENT_ID>',     'ads_client_id_<tenant>',     'Ads client_id');
select vault.create_secret('<ADS_CLIENT_SECRET>', 'ads_client_secret_<tenant>', 'Ads client_secret');
select vault.create_secret('<ADS_REFRESH_TOKEN>', 'ads_refresh_token_<tenant>', 'Ads refresh_token');
-- deren IDs (aus vault.secrets) in einen auth_context mit source='ads':
insert into public.auth_contexts
  (tenant_id, source, region, profile_id, client_id_secret, client_secret_secret, refresh_token_secret)
values
  ('62b44111-8088-493e-982c-e2c8d8452efa', 'ads', 'eu', '<PROFILE_ID>',
   '<id_client_id>', '<id_client_secret>', '<id_refresh_token>');
```

Dann: `POST /functions/v1/sync-ads-report {tenant_id, days:14}` → sollte DONE
liefern. Danach `get_ads_overview` über MCP. Ads in den Scheduler aufnehmen: ein
eigener Cron-Job (sync-ads-report hat einen anderen Endpunkt als sync-report) —
noch nicht angelegt, siehe „Was als Nächstes".

---

---

## Frontend-Auth-Schicht (fertig + getestet) — für das Multi-Tenant-Portal

Damit sich Seller-Kunden in einem Web-Frontend einloggen und NUR ihre Daten sehen.

- **Migration `tenant_members`** (...0007): Zuordnung auth.users → tenant, plus
  `my_tenant_id()` (Tenant des eingeloggten Nutzers über auth.uid(), nicht fälschbar).
- **Function `api`** (verify_jwt=true): Read-Endpunkt fürs Frontend. Auth per
  Supabase-SESSION-JWT (nicht Bearer wie MCP). Tenant aus der Identität, nie aus
  dem Body. Nutzt exakt die MCP-Tool-Handler (`rufeToolAuf` in mcp.ts) — Web und KI
  liefern dieselben Zahlen, Logik nur an einer Stelle.
- **Details/Spec: `FRONTEND.md`** (Endpunkt, Ressourcen, Beispielcode,
  Kunden-Nutzer anlegen).

**Am echten Backend getestet (2026-07-18):** Test-User angelegt → tenant_members
→ Login → `api` liefert die Kennzahlen des richtigen Tenants. Sicherheit:
kein Auth → 401, anon statt Session → 401, fremde tenant_id im Body → wirkungslos
(Tenant kommt aus my_tenant_id), alle 6 Ressourcen abrufbar, unbekannte → Fehler.
Test-User danach gelöscht.

**Noch zu tun fürs Portal:** das eigentliche Frontend (Lovable oder eigenes React)
gegen `api` bauen; Kunden-Nutzer anlegen + zuordnen (FRONTEND.md).

### connect-sp — Seller verbindet sein SP-API-Konto (fertig + getestet)

Function `connect-sp` (verify_jwt=true) + RPC `upsert_vault_secret` (Migration ...0008).
Der eingeloggte Seller reicht SEINE eigenen Credentials ein (client_id,
client_secret, refresh_token, marketplace_id). Ablauf: Session → my_tenant_id →
**live bei Amazon validieren (VOR dem Speichern)** → bei Erfolg Secrets in den
Vault (deterministische Namen `sp_*_<tenant>`, idempotent) → auth_contexts upserten
(source 'sp', status 'connected'). Secrets werden nie geloggt/zurückgegeben.
Spec + Frontend-Nutzung: FRONTEND.md.

**WICHTIG — bewusste Entscheidung (2026-07-18): KEIN OAuth-Flow, es bleibt bei
Weg A.** Die Aufgabe war ursprünglich als spapi_oauth_code-OAuth-Flow formuliert.
Auf Nachfrage entschieden: bei Self-Auth bleiben (passt zum dokumentierten Modell).
Ein OAuth-Flow bräuchte EINE zentrale, von Amazon genehmigte App — die gibt es
nicht. connect-sp nimmt daher den vom Seller SELBST erzeugten refresh_token entgegen,
kein Code-Tausch. Falls doch mal auf Weg B umgestellt wird: client_id/secret werden
dann GLOBAL (eine App), nur refresh_token pro Tenant — dann Schema/Function anpassen.

**Getestet (2026-07-18, isoliert gegen Wegwerf-Tenant):** upsert_vault_secret
Roundtrip + idempotenter Update. connect-sp: kein Auth → 401, Pflichtfelder fehlen
→ 400, Bogus-Credentials → echte Amazon-Ablehnung (invalid_client) → 400 und
NICHTS gespeichert (validate-before-store bestätigt). Happy Path (echte Credentials
→ gespeichert) bewusst NICHT selbst getestet (keine Klartext-Secrets anfassen) —
vom Betreiber mit echten Daten zu verifizieren, danach via get-access-token prüfbar.

Aufräum-Notiz: Ein Test-Secret `__test_connect_dummy` liegt noch im Vault (harmlos,
Roundtrip-Test). Kann bei Bedarf entfernt werden (es gibt noch keine delete-RPC).

---

## Was als Nächstes ansteht (Priorität grob von oben)

> **Die drei manuellen Inbetriebnahme-Schritte (0–2) stehen mit genauen Befehlen
> und Erfolgskontrollen in `INBETRIEBNAHME.md`.** Erst danach läuft das System
> produktiv (Auto-Sync + KI-Zugriff).

0. **Scheduler scharfschalten:** die zwei Vault-Secrets setzen.
   Danach ist der tägliche Auto-Sync aktiv.
1. **MCP an einen echten KI-Client anbinden** und einen Produktiv-Token ausstellen.
2. **FBA-Lagerbestand freischalten:** App-Rolle "Amazon Fulfillment" anhaken +
   neu autorisieren (neuer Refresh-Token in Vault). Dann läuft
   GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA ohne Code-Änderung; Aufbereitung +
   MCP-Tool dafür bauen (Reichweite, Inbound, ausverkaufte FBA-SKUs).
3. **Weitere Reports:** je eigener Parser bzw.
   REPORT_KONFIG-Eintrag; das TSV-Gerüst steht.
4. **Scheduler-Ausbau:** weitere Report-Typen in internal.scheduler_reports; Fehler pro
   Tenant isolieren (toter Token darf andere nicht blockieren). sync-report ist
   dafür vorbereitet: bei PROCESSING einfach später mit report_id nachfassen.
5. **Ads-API (Phase 2):** eigener Auth-Flow, v3 async Reports, is_provisional
   für letzte ~72h (volatil).
6. **MCP-Tools erweitern:** get_product_performance (je ASIN über Zeit),
   Zeitraum-Argumente, weitere Reports als Tools — sobald sie existieren.

---

## Prinzipien (nicht brechen)

- Tokens/Secrets NIE im Klartext, NIE im Frontend, NIE loggen. Immer über Vault.
- service_role umgeht RLS → in JEDER Query zusätzlich .eq('tenant_id', ...).
- Erst ein Report/Feature komplett + getestet, dann nächstes. Kein Big-Bang.
- LLM/KI nur für Framing/Interpretation, NIE für die Zahlen. Rechnen im Code.
- Datenverarbeiter-Rolle (DSGVO): AVV mit Kunden, sichere Speicherung, Haftung.

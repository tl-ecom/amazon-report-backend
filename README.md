# Amazon Report Backend

Multi-Tenant Supabase-Middleware für Amazon SP-API Reports.
Siehe `UEBERGABE.md` für den vollständigen Kontext und Stand.

**Produktiv schalten:** `INBETRIEBNAHME.md` — die drei manuellen Schritte
(Scheduler-Secrets, MCP-Token/KI-Client, optional FBA-Rolle).

---

## So startest du in Claude Code

1. **Diesen Ordner in deinen Projects-Ordner legen** (entpacken, falls als Zip).

2. **Claude Code im Ordner öffnen** (Terminal im Ordner, dann `claude`), oder den
   Ordner in der Claude-Desktop/Code-Oberfläche öffnen.

3. **Ersten Prompt geben**, z.B.:

   > "Lies UEBERGABE.md und mach beim nächsten offenen Punkt weiter."

4. **Cloud verbinden** (einmalig; ist bereits erledigt, hier zur Reproduktion):
   ```
   supabase login
   supabase link --project-ref DEIN_PROJECT_REF
   supabase functions download --use-api        # lädt alle Functions
   ```
   `--use-api` entpackt serverseitig und braucht kein Docker.
   ACHTUNG: `functions download` überschreibt die lokalen Dateien —
   vorher sichern, wenn du vergleichen willst.

---

## Projektstruktur

```
amazon-report-backend/
├── README.md                  ← diese Datei
├── UEBERGABE.md               ← vollständiger Kontext & nächste Schritte
├── .gitignore                 ← schützt Secrets vor versehentlichem Commit
├── .env.example               ← Vorlage für lokale Variablen (ohne echte Werte!)
└── supabase/
    ├── config.toml            ← Supabase-Projektkonfiguration (minimal)
    ├── migrations/
    │   ├── ...phase1_schema.sql
    │   ├── ...read_vault_secret.sql
    │   └── ...scheduler.sql        ← pg_cron: täglicher Auto-Sync
    └── functions/
        ├── _shared/metrics.ts          ← Sales-&-Traffic-Kennzahlen (+ Tests)
        ├── _shared/orders.ts           ← Orders-Kennzahlen (+ Tests)
        ├── _shared/ratelimit.ts        ← Wartezeiten aus Amazons Headern (+ Tests)
        ├── _shared/tsv.ts              ← Flat-File/TSV + PII-Filter (+ Tests)
        ├── sync-report/index.ts        ← Report holen: alle Stufen in EINEM Aufruf
        ├── get-sales-overview/index.ts  ← Sales-&-Traffic-Kennzahlen
        ├── get-orders-overview/index.ts ← Orders-Kennzahlen
        ├── get-access-token/index.ts   ← Diagnostik: prüft die Zugangsdaten
        ├── request-report/index.ts     ← Stufe 1 einzeln (Debug)
        ├── check-report/index.ts       ← Stufe 2 einzeln (Debug)
        └── fetch-report/index.ts       ← Stufe 3 einzeln (Debug)
```

---

## Normaler Ablauf

**1. Report holen** — ein Aufruf genügt:

```
POST /functions/v1/sync-report
Body: { "tenant_id": "..." }
```

- `{status:"DONE"}` → Daten liegen in `report_data`
- `{status:"PROCESSING", report_id}` → Amazon ist noch nicht fertig, das ist KEIN
  Fehler. Erneut aufrufen mit `{ "tenant_id": "...", "report_id": "..." }`,
  dann wird direkt abgeholt statt neu angefordert.

Bei Sales & Traffic endet der Zeitraum standardmäßig 2 Tage vor heute — Amazons
Traffic-Daten hinken so lange nach, und ein Fenster bis heute verzerrt die CVR.
Wer die letzten Tage trotzdem braucht: `include_volatile: true`, dann ist der
Datensatz `is_provisional`.

Andere Report-Typen über `report_type`, z.B. der Orders-Report (TSV):

```
Body: { "tenant_id": "...", "report_type": "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL", "days": 30 }
```

Standortdaten der Endkunden (`ship-city`, `ship-state`, `ship-postal-code`) werden
dabei schon beim Speichern verworfen — `ship-country` bleibt. Siehe UEBERGABE.md.

**2. Kennzahlen abfragen:**

```
POST /functions/v1/get-sales-overview
Body: { "tenant_id": "..." }
```

Liefert Umsatz, Sessions, CVR, Durchschnittspreis und Zahlen je ASIN — alle aus
den Rohwerten gerechnet, nie aus Amazons Prozentspalten. Mit `data_timestamp`,
`is_provisional` und den verwendeten Formeln.

Für Bestellungen entsprechend:

```
POST /functions/v1/get-orders-overview
Body: { "tenant_id": "..." }
```

**Die beiden Übersichten NICHT gegeneinander rechnen.** get-sales-overview deckt
EINEN Marktplatz ab, get-orders-overview enthält mehrere Kanäle (inkl.
Multi-Channel-Fulfillment). Bei Orders gilt außerdem: ein leeres Preisfeld heißt
"unbekannt", nicht "0 €" — die Antwort weist das über `umsatzVollstaendig` und
`warnungen` aus.

Details und Begründungen: siehe UEBERGABE.md.

## Tests

```
npx deno@2 test supabase/functions/_shared/
```

## Manueller Ablauf (nur noch zum Debuggen einzelner Stufen)

1. `request-report`  Body: `{ "tenant_id": "..." }` → liefert `reportId`
2. `check-report`    Body: `{ "tenant_id": "...", "report_id": "..." }` → bei DONE `reportDocumentId`
3. `fetch-report`    Body: `{ "tenant_id": "...", "report_document_id": "..." }` → speichert Daten

Test-Tenant-ID siehe UEBERGABE.md.

---

## Sicherheit

- Keine Secrets in diesem Repo. Alle Credentials liegen in Supabase Vault
  bzw. im Passwort-Manager.
- `.env` ist gitignored. Nur `.env.example` (ohne echte Werte) gehört ins Repo.
- Vor jedem Commit prüfen, dass keine Keys/Tokens in geänderten Dateien stehen.

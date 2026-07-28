# Operator Pulse — E-Mail-Vorlagen (Supabase Auth)

Ersetzen die kargen Standard-Templates von Supabase. Die Standardvorlagen bestehen
aus einem Satz und einem nackten Link — genau das Muster, das Spamfilter abwerten.

## Einfügen

Supabase → **Authentication → Emails → Templates**, dann pro Vorlage den
**Betreff** setzen und den **Inhalt** der jeweiligen Datei komplett einfügen:

| Template in Supabase | Datei | Betreff |
|---|---|---|
| Invite user | `invite.html` | `Dein Zugang zu Operator Pulse` |
| Reset Password | `recovery.html` | `Passwort zurücksetzen — Operator Pulse` |

Betreffzeilen bewusst ohne Ausrufezeichen, Emojis oder Wörter wie "kostenlos",
"jetzt" oder "dringend" — die triggern Spamfilter.

## Warum tabellenbasiert und Inline-Styles

Mailclients (vor allem Outlook) ignorieren `<style>`-Blöcke, CSS-Variablen,
Flexbox und `oklch()`. Darum:

- Layout über `<table>` statt Flex/Grid
- alle Styles inline am Element
- Farben als feste Hex-Werte (Ableitung aus dem Frontend-Theme):
  - Hintergrund `#0a0a0f`, Karte `#14141c`, Rahmen `#2a2a38`
  - Text `#e9e9f2`, gedämpft `#9a9aae`
  - Violett `#a855f7`, Button-Verlauf `#7c3aed → #a855f7`
- Button mit `bgcolor` **und** `background-image`: Outlook zeigt die Volltonfarbe,
  moderne Clients den Verlauf

## Variablen

Supabase ersetzt beim Versand:

- `{{ .ConfirmationURL }}` — der Aktionslink (zeigt auf die **Site URL** aus
  *Authentication → URL Configuration*, aktuell `https://pulse.amz-connect.de`)
- `{{ .Email }}` — die Empfängeradresse

## Zustellbarkeit

Die Vorlagen allein lösen kein Spam-Problem. Ergänzend nötig:

- **SPF + DKIM**: über Resend eingerichtet und verifiziert (`send.amz-connect.de`)
- **DMARC**: TXT-Eintrag `_dmarc.send` → `v=DMARC1; p=none;` bei IONOS
- **Reputation**: baut sich erst über zugestellte und geöffnete Mails auf. Die ersten
  Sendungen einer neuen Domain landen häufiger im Spam — das legt sich.

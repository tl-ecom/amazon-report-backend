# Eingang für Maßnahmen-Tabellen

Excel-Dateien (z. B. „PPC-Maßnahmen … .xlsx" aus Claude Chat) hier ablegen.
`python tools/ads_gebote.py tabelle --firma <Firma>` nimmt ohne `--datei`
automatisch die neueste .xlsx aus diesem Ordner.

Die Tabellen enthalten Kundendaten und bleiben lokal: `*.xlsx` in diesem Ordner
ist per .gitignore vom Repo ausgeschlossen.

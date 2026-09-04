#!/usr/bin/env python3
"""
ads_gebote.py — Gebote fuer Sponsored Products lesen und setzen (nur Coach, nur lokal).

Ruft die Edge Function `ads-gebote` mit DEINER Supabase-Session auf. Du bist damit
derselbe Nutzer wie in der Coach-Ansicht des Portals; die Function laesst nur
Plattform-Admins durch. ChatGPT/MCP haben diesen Weg nicht.

Ablauf:
  1. Einmalig anmelden (Passwort wird abgefragt, nie gespeichert; nur die Session
     landet in tools/.op_session.json, die Datei ist in .gitignore):
        python tools/ads_gebote.py login

  2. Kampagnen ansehen:
        python tools/ads_gebote.py kampagnen --firma Vaneja
        python tools/ads_gebote.py kampagnen --firma Vaneja --status ENABLED,PAUSED,ARCHIVED

  3. Gebote einer oder mehrerer Kampagnen ansehen (ID oder Namensteil, mehrfach):
        python tools/ads_gebote.py gebote --firma Vaneja --kampagne "Brand" --kampagne 12345

  4. Vorschau einer Aenderung (schreibt NICHTS, legt tools/.vorschau.json ab):
        python tools/ads_gebote.py vorschau --firma Vaneja --kampagne "Brand" --prozent -20
        python tools/ads_gebote.py vorschau --firma Vaneja --kampagne "Brand" --faktor 0.8 --min 0.25
        python tools/ads_gebote.py vorschau --firma Vaneja --kampagne "Brand" --absolut 0.45 --nur keyword

  5. Genau diese Vorschau anwenden (fragt noch einmal nach, ausser mit --ja):
        python tools/ads_gebote.py setzen --firma Vaneja --grund "ACOS zu hoch"

Wo ausfuehren: auf dem PC (nicht VPS). Braucht nur Python 3 + requests.
"""

import argparse
import getpass
import json
import os
import sys
import time

import requests

# Windows-Konsole: Umlaute sauber ausgeben
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SUPABASE_URL = "https://irvnghhxfjjnpodclfuc.supabase.co"
# oeffentlicher anon-Key (kein Geheimnis, siehe FRONTEND.md)
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlydm5naGh4ZmpqbnBvZGNsZnVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzUzNDAsImV4cCI6MjA5OTgxMTM0MH0."
    "lUSreFAj7oB5dN_KO2GKrb5s6COaUCiQm0_GZuQYJtM"
)
HIER = os.path.dirname(os.path.abspath(__file__))
SESSION_DATEI = os.path.join(HIER, ".op_session.json")
VORSCHAU_DATEI = os.path.join(HIER, ".vorschau.json")
FUNKTION = f"{SUPABASE_URL}/functions/v1/ads-gebote"


# ----------------------------------------------------------------- Session

def _speichere_session(d):
    with open(SESSION_DATEI, "w", encoding="utf-8") as f:
        json.dump({
            "access_token": d["access_token"],
            "refresh_token": d["refresh_token"],
            "expires_at": int(time.time()) + int(d.get("expires_in", 3600)),
            "email": (d.get("user") or {}).get("email"),
        }, f)


def login(args):
    email = args.email or input("E-Mail [info@tl-ecom.de]: ").strip() or "info@tl-ecom.de"
    pw = getpass.getpass("Passwort: ")
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": pw}, timeout=30,
    )
    if r.status_code != 200:
        sys.exit(f"Anmeldung fehlgeschlagen ({r.status_code}): {r.text[:300]}")
    _speichere_session(r.json())
    print(f"Angemeldet als {email}. Session liegt in {SESSION_DATEI}")


def token():
    if not os.path.exists(SESSION_DATEI):
        sys.exit("Keine Session. Erst:  python tools/ads_gebote.py login")
    with open(SESSION_DATEI, encoding="utf-8") as f:
        s = json.load(f)
    if s.get("expires_at", 0) - 60 > time.time():
        return s["access_token"]
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"refresh_token": s["refresh_token"]}, timeout=30,
    )
    if r.status_code != 200:
        sys.exit(f"Session abgelaufen, bitte neu anmelden (login). {r.text[:200]}")
    d = r.json()
    _speichere_session(d)
    return d["access_token"]


def ruf(body):
    r = requests.post(
        FUNKTION,
        headers={"Authorization": f"Bearer {token()}", "apikey": ANON_KEY, "Content-Type": "application/json"},
        json=body, timeout=300,
    )
    try:
        d = r.json()
    except ValueError:
        sys.exit(f"Unerwartete Antwort ({r.status_code}): {r.text[:300]}")
    if r.status_code >= 400:
        sys.exit(f"Fehler {r.status_code}: {json.dumps(d, ensure_ascii=False)[:800]}")
    return d


# ----------------------------------------------------------------- Aufloesen

def firma_id(name):
    firmen = ruf({"action": "firmen"})["firmen"]
    treffer = [f for f in firmen if f["name"] and name.lower() in f["name"].lower()]
    if len(treffer) == 1:
        return treffer[0]["tenant_id"], treffer[0]["name"]
    if not treffer:
        sys.exit("Keine Firma mit Ads-Verbindung passt zu '%s'. Vorhanden: %s"
                 % (name, ", ".join(f["name"] or "?" for f in firmen)))
    sys.exit("Mehrdeutig: " + ", ".join(f["name"] for f in treffer))


def kampagnen_ids(tenant, auswahl, status):
    alle = ruf({"action": "kampagnen", "company_id": tenant, "status": status})["kampagnen"]
    ids, namen = [], []
    for a in auswahl:
        exakt = [k for k in alle if k["campaignId"] == a]
        treffer = exakt or [k for k in alle if a.lower() in (k["name"] or "").lower()]
        if not treffer:
            sys.exit(f"Keine Kampagne passt zu '{a}' (Status-Filter: {status}).")
        for k in treffer:
            if k["campaignId"] not in ids:
                ids.append(k["campaignId"])
                namen.append(k["name"])
    return ids, namen, {k["campaignId"]: k["name"] for k in alle}


# ----------------------------------------------------------------- Filter

def filtere(zeilen, treffer):
    """--treffer: nur Zeilen, deren id ODER text (Teilstring, ohne Gross/Klein) passt."""
    if not treffer:
        return zeilen
    out = []
    for z in zeilen:
        for t in treffer:
            if z["id"] == t or t.lower() in (z.get("text") or "").lower():
                out.append(z)
                break
    return out


# ----------------------------------------------------------------- Ausgabe

def tabelle(zeilen, spalten):
    if not zeilen:
        print("(keine Zeilen)")
        return
    breiten = [max(len(str(s)), *(len(str(z.get(s, ""))) for z in zeilen)) for s in spalten]
    breiten = [min(b, 48) for b in breiten]
    kopf = "  ".join(str(s).ljust(b) for s, b in zip(spalten, breiten))
    print(kopf)
    print("-" * len(kopf))
    for z in zeilen:
        print("  ".join(str(z.get(s, ""))[:b].ljust(b) for s, b in zip(spalten, breiten)))


# ----------------------------------------------------------------- Befehle

def cmd_firmen(args):
    tabelle(ruf({"action": "firmen"})["firmen"], ["name", "tenant_id", "profile_id", "marketplace_id", "status"])


def cmd_kampagnen(args):
    tenant, name = firma_id(args.firma)
    d = ruf({"action": "kampagnen", "company_id": tenant, "status": args.status.split(",")})
    print(f"Firma: {name}   Ads-Profil: {d['profile_id']}   Kampagnen: {len(d['kampagnen'])}")
    tabelle(d["kampagnen"], ["campaignId", "name", "state", "targetingType", "budget", "strategie"])


def cmd_gebote(args):
    tenant, name = firma_id(args.firma)
    ids, namen, kname = kampagnen_ids(tenant, args.kampagne, args.kampagnen_status.split(","))
    d = ruf({"action": "gebote", "company_id": tenant, "kampagnen": ids, "status": args.status.split(","), "nur": args.nur})
    d["zeilen"] = filtere(d["zeilen"], args.treffer)
    for z in d["zeilen"]:
        z["kampagne"] = kname.get(z["campaignId"], z["campaignId"])
    print(f"Firma: {name}   Kampagnen: {', '.join(namen)}")
    print(f"Zeilen mit eigenem Gebot: {d['anzahl']}   erben Standardgebot der Anzeigengruppe: {d['erben_standard']}"
          + (f"   nach Filter: {len(d['zeilen'])}" if args.treffer else ""))
    tabelle(sorted(d["zeilen"], key=lambda z: (z["kampagne"], -z["gebot"])),
            ["kampagne", "art", "text", "matchType", "state", "gebot", "id"])


def cmd_vorschau(args):
    tenant, name = firma_id(args.firma)
    ids, namen, kname = kampagnen_ids(tenant, args.kampagne, args.kampagnen_status.split(","))
    regel = {k: getattr(args, k) for k in ("prozent", "faktor", "absolut", "min", "max") if getattr(args, k) is not None}
    d = ruf({"action": "vorschau", "company_id": tenant, "kampagnen": ids, "status": args.status.split(","),
             "nur": args.nur, "regel": regel})
    d["aenderungen"] = filtere(d["aenderungen"], args.treffer)
    for a in d["aenderungen"]:
        a["kampagne"] = kname.get(a["campaignId"], a["campaignId"])
    z = d["zusammenfassung"]
    if args.treffer:
        ae = d["aenderungen"]
        z = {"anzahl": len(ae), "keywords": sum(a["art"] == "keyword" for a in ae), "targets": sum(a["art"] == "target" for a in ae),
             "summe_alt": round(sum(a["gebot"] for a in ae), 2), "summe_neu": round(sum(a["neu"] for a in ae), 2)}
    print(f"Firma: {name}   Kampagnen: {', '.join(namen)}   Regel: {regel}")
    print(f"Aenderungen: {z['anzahl']} (Keywords {z['keywords']}, Targets {z['targets']})   "
          f"Summe Gebote {z['summe_alt']} -> {z['summe_neu']}   ohne eigenes Gebot (unveraendert): {d['erben_standard']}")
    tabelle(sorted(d["aenderungen"], key=lambda a: (a["kampagne"], -a["gebot"])),
            ["kampagne", "art", "text", "matchType", "gebot", "neu", "delta", "id"])
    with open(VORSCHAU_DATEI, "w", encoding="utf-8") as f:
        json.dump({"firma": name, "tenant_id": tenant, "kampagnen": namen, "regel": regel,
                   "erstellt": time.strftime("%Y-%m-%d %H:%M:%S"), "aenderungen": d["aenderungen"]}, f, ensure_ascii=False, indent=1)
    print(f"\nNICHTS geschrieben. Vorschau liegt in {VORSCHAU_DATEI}.")
    print("Anwenden:  python tools/ads_gebote.py setzen --firma %s --grund \"...\"" % args.firma)


def cmd_setzen(args):
    if not os.path.exists(VORSCHAU_DATEI):
        sys.exit("Keine Vorschau vorhanden. Erst:  python tools/ads_gebote.py vorschau ...")
    with open(VORSCHAU_DATEI, encoding="utf-8") as f:
        v = json.load(f)
    tenant, name = firma_id(args.firma)
    if tenant != v["tenant_id"]:
        sys.exit(f"Die Vorschau gehoert zu '{v['firma']}', nicht zu '{name}'. Abbruch.")
    aend = v["aenderungen"]
    if not aend:
        sys.exit("Die Vorschau enthaelt keine Aenderungen.")
    print(f"Firma: {name}   Kampagnen: {', '.join(v['kampagnen'])}   Regel: {v['regel']}   Vorschau von {v['erstellt']}")
    print(f"{len(aend)} Gebote werden bei Amazon gesetzt.")
    if not args.ja:
        antwort = input("Wirklich schreiben? (ja/nein): ").strip().lower()
        if antwort != "ja":
            sys.exit("Abgebrochen. Nichts geschrieben.")
    d = ruf({"action": "setzen", "company_id": tenant, "bestaetigung": True, "grund": args.grund,
             "aenderungen": [{"art": a["art"], "id": a["id"], "gebot": a["gebot"], "neu": a["neu"]} for a in aend]})
    print(f"Geschrieben: {d['geschrieben']}   Fehler: {d['fehler']}   Uebersprungen: {d['uebersprungen']}")
    problem = [e for e in d["ergebnisse"] if e["ergebnis"] != "ok"]
    if problem:
        print("\nNicht geschrieben:")
        tabelle(problem, ["art", "id", "text", "alt", "neu", "ergebnis", "detail"])
    if d.get("log_fehler"):
        print(f"WARNUNG: Log konnte nicht geschrieben werden: {d['log_fehler']}")
    os.remove(VORSCHAU_DATEI)


# ----------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description="Gebote fuer Sponsored Products lesen/setzen (nur Coach, nur lokal).")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("login", help="einmalig anmelden (Passwort wird abgefragt)")
    s.add_argument("--email")
    s.set_defaults(fn=login)

    s = sub.add_parser("firmen", help="Firmen mit Ads-Verbindung")
    s.set_defaults(fn=cmd_firmen)

    s = sub.add_parser("kampagnen", help="Kampagnen einer Firma")
    s.add_argument("--firma", required=True)
    s.add_argument("--status", default="ENABLED,PAUSED", help="ENABLED,PAUSED,ARCHIVED")
    s.set_defaults(fn=cmd_kampagnen)

    def auswahl(s):
        s.add_argument("--firma", required=True)
        s.add_argument("--kampagne", action="append", required=True, help="campaignId oder Namensteil, mehrfach moeglich")
        s.add_argument("--kampagnen-status", default="ENABLED,PAUSED", help="welche Kampagnen beim Namens-Match zaehlen")
        s.add_argument("--status", default="ENABLED", help="Status der Keywords/Targets: ENABLED,PAUSED")
        s.add_argument("--nur", choices=["keyword", "target"], default=None, help="nur Keywords oder nur Product-Targets")
        s.add_argument("--treffer", action="append", default=None, help="nur diese Zeilen: Keyword-/Target-ID oder Textteil, mehrfach moeglich")

    s = sub.add_parser("gebote", help="aktuelle Gebote ansehen")
    auswahl(s)
    s.set_defaults(fn=cmd_gebote)

    s = sub.add_parser("vorschau", help="Aenderung berechnen, nichts schreiben")
    auswahl(s)
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--prozent", type=float, help="z. B. -20 (senken) oder 10 (erhoehen)")
    g.add_argument("--faktor", type=float, help="z. B. 0.8")
    g.add_argument("--absolut", type=float, help="festes Zielgebot")
    s.add_argument("--min", type=float, help="nicht unter diesen Wert (Amazon-Minimum 0.02)")
    s.add_argument("--max", type=float, help="nicht ueber diesen Wert")
    s.set_defaults(fn=cmd_vorschau)

    s = sub.add_parser("setzen", help="die letzte Vorschau bei Amazon anwenden")
    s.add_argument("--firma", required=True)
    s.add_argument("--grund", default=None, help="kurze Begruendung fuers Log")
    s.add_argument("--ja", action="store_true", help="ohne Rueckfrage")
    s.set_defaults(fn=cmd_setzen)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

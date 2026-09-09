-- Steuerliche Stammdaten des Verkaeufers.
--
-- Anlass: Amazon stellt Gebuehren brutto in Rechnung (an einer Bestellung
-- nachgerechnet: 15 % von 44,97 € = 6,75 € netto, gebucht wurden 8,03 € =
-- 6,75 × 1,19). Die Vorsteuer kommt also zurueck — aber WANN, haengt vom
-- Voranmeldungsrhythmus ab, und OB, davon ob die Firma ueberhaupt
-- vorsteuerabzugsberechtigt ist. Beides kann Pulse nicht messen; das weiss nur
-- der Verkaeufer.
--
-- Alle neuen Felder sind NULLABLE, und das ist Absicht: "OSS: nein" und
-- "OSS: nicht angegeben" sind zwei verschiedene Aussagen. Ein Default auf
-- false wuerde eine Angabe erfinden, die niemand gemacht hat — genau das,
-- was dieses Projekt sonst vermeidet.

alter table public.tenant_einstellungen
  -- false = Kleinunternehmer nach § 19 UStG: keine USt auf Rechnungen,
  -- dafuer auch kein Vorsteuerabzug. Aendert die gesamte Cash-Rechnung.
  add column if not exists umsatzsteuerpflichtig boolean,
  -- Rhythmus der Umsatzsteuer-Voranmeldung. Bestimmt, wann die Vorsteuer
  -- aus den Amazon-Gebuehren tatsaechlich auf dem Konto ankommt.
  add column if not exists ust_voranmeldung text,
  -- Dauerfristverlaengerung: verschiebt Abgabe und Erstattung um einen Monat.
  add column if not exists ust_dauerfristverlaengerung boolean,
  -- Fuehrt die Firma auch Artikel zu 7 %? Dann ist EIN Firmensatz zu grob und
  -- die Saetze gehoeren je ASIN gepflegt (asin_einstellungen.ust_prozent).
  add column if not exists ermaessigter_satz boolean,
  -- One-Stop-Shop: EU-Fernverkaeufe werden zentral in DE gemeldet.
  add column if not exists oss_teilnahme boolean,
  -- Pan-EU: Amazon verteilt Ware selbsttaetig in andere Laender. Loest dort
  -- Registrierungspflichten aus und erzeugt Lagergebuehren in Fremdwaehrung.
  add column if not exists pan_eu boolean,
  -- Ware liegt im Ausland (Pan-EU, CEE oder eigenes Lager).
  add column if not exists lager_ausland boolean,
  add column if not exists lager_laender text[],
  add column if not exists stammdaten_bestaetigt_am timestamptz;

alter table public.tenant_einstellungen
  drop constraint if exists tenant_einstellungen_ust_voranmeldung_check;
alter table public.tenant_einstellungen
  add constraint tenant_einstellungen_ust_voranmeldung_check
  check (ust_voranmeldung is null
         or ust_voranmeldung in ('monatlich','vierteljaehrlich','jaehrlich','keine'));

comment on column public.tenant_einstellungen.umsatzsteuerpflichtig is
  'NULL = nicht angegeben. false = Kleinunternehmer § 19 UStG (kein Vorsteuerabzug).';
comment on column public.tenant_einstellungen.ust_voranmeldung is
  'monatlich | vierteljaehrlich | jaehrlich | keine. NULL = nicht angegeben.';
comment on column public.tenant_einstellungen.lager_laender is
  'ISO-Laendercodes, in denen Ware liegt. NULL = nicht angegeben, {} = ausdruecklich keine.';

notify pgrst, 'reload schema';;

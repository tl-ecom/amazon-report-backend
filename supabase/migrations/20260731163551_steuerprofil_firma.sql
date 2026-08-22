-- Steuerprofil der Firma. Beantwortet die USt.-Frage direkt, statt sie an
-- jeder Auswertung neu zu stellen.
--
-- Voreinstellung DE + vorsteuerabzugsberechtigt: der weit überwiegende Fall.
-- Daraus folgt, dass Amazon-Gebühren 19 % deutsche USt. enthalten und diese
-- als Vorsteuer erstattet wird — sie gehört also nicht in die Marge.
--
-- NOT NULL mit Default, damit bestehende Firmen sofort eine definierte Antwort
-- haben und nicht in einem stillen "unbekannt" hängen.
alter table public.tenant_einstellungen
  add column if not exists firmensitz_land text not null default 'DE',
  add column if not exists vorsteuerabzug boolean not null default true,
  add column if not exists steuerprofil_bestaetigt_am timestamptz;

comment on column public.tenant_einstellungen.firmensitz_land is
  'Sitz des Unternehmens (ISO-2). Bestimmt, ob Amazon mit deutscher USt. oder im Reverse-Charge-Verfahren abrechnet.';
comment on column public.tenant_einstellungen.vorsteuerabzug is
  'Vorsteuerabzugsberechtigt? false = Kleinunternehmer/pauschaliert -> die USt. ist echte Kosten und wird NICHT herausgerechnet.';
comment on column public.tenant_einstellungen.steuerprofil_bestaetigt_am is
  'Wann die Firma das Profil selbst bestaetigt hat. NULL = laeuft noch auf der Voreinstellung.';;

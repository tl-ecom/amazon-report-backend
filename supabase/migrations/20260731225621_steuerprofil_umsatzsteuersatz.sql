-- Umsatzsteuersatz auf den EIGENEN Umsatz. Nicht zu verwechseln mit dem Satz in
-- den Amazon-Gebühren: dort geht es um Vorsteuer, hier um die Steuer, die der
-- Verkäufer vereinnahmt und abführt.
--
-- Sie ist kein Ertrag. Ein Umsatz von 9.356 € brutto sind bei 19 % nur 7.862 €,
-- die dem Verkäufer gehören. Wer die Marge auf den Bruttoumsatz rechnet, während
-- die Gebühren netto stehen, rechnet sich systematisch reich.
--
-- 19 = Regelsatz Deutschland. 0 = Kleinunternehmer (§19 UStG) — der weist keine
-- USt. aus, sein Umsatz IST netto.
alter table public.tenant_einstellungen
  add column if not exists umsatzsteuer_prozent numeric not null default 19;

comment on column public.tenant_einstellungen.umsatzsteuer_prozent is
  'USt.-Satz auf den eigenen Umsatz. 19 = Regelsatz DE, 7 = ermaessigt, 0 = Kleinunternehmer (Umsatz ist dann bereits netto).';

-- Kleinunternehmer weisen keine USt. aus — dort waere ein Herausrechnen falsch.
update public.tenant_einstellungen
set umsatzsteuer_prozent = 0
where vorsteuerabzug = false and umsatzsteuer_prozent = 19;;

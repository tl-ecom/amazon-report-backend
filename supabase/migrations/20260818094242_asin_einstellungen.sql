-- asin_einstellungen — was je PRODUKT eingestellt wird, nicht je Mandant.
--
-- Bisher lagen Ziel-ACOS und Umsatzsteuersatz in tenant_einstellungen, also
-- einmal fuer alle Produkte. Beides ist aber produktabhaengig: ein Artikel mit
-- 36 % Rohmarge vertraegt keinen Ziel-ACOS, der fuer einen mit 80 % passt, und
-- der Steuersatz haengt an der Ware (7 % z. B. bei Lebensmitteln).
--
-- BEWUSST NICHT in asin_ek: das ist ueber gueltig_ab eine Preishistorie. Eine
-- Einstellung soll nicht mitversioniert werden — sonst haette derselbe Artikel
-- je nach EK-Stand verschiedene Ziele.
--
-- null heisst ueberall „keine Angabe", nicht 0:
--   ziel_acos_prozent null -> keine Vorgabe fuer dieses Produkt
--   ust_prozent       null -> es gilt tenant_einstellungen.umsatzsteuer_prozent

create table if not exists public.asin_einstellungen (
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  asin              text not null,
  ziel_acos_prozent numeric,
  ust_prozent       numeric,
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, asin),
  constraint asin_einstellungen_ziel_acos_bereich
    check (ziel_acos_prozent is null or (ziel_acos_prozent >= 0 and ziel_acos_prozent <= 100)),
  -- Nur real vorkommende Saetze zulassen. Ein Tippfehler wie 1,9 statt 19 waere
  -- sonst nicht von einer Absicht zu unterscheiden und verfaelschte jede Marge.
  constraint asin_einstellungen_ust_erlaubt
    check (ust_prozent is null or ust_prozent in (0, 7, 19))
);

comment on table public.asin_einstellungen is
  'Je Produkt einstellbar: Ziel-ACOS und Umsatzsteuersatz. null = keine Angabe (beim Steuersatz gilt dann der Mandanten-Wert). Getrennt von asin_ek, weil das eine Preishistorie ist und Einstellungen nicht mitversioniert werden sollen.';

alter table public.asin_einstellungen enable row level security;

notify pgrst, 'reload schema';;

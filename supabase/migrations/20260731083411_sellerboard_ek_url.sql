-- Sellerboard-Export-Link für die Einkaufspreise. Der Link enthält ein Token,
-- gehört also NICHT im Klartext in eine normale Tabelle -> Vault, hier nur die
-- Secret-Referenz (gleiches Muster wie die SP-API-Zugangsdaten).
alter table public.tenant_einstellungen
  add column if not exists sellerboard_ek_url_secret uuid,
  add column if not exists sellerboard_ek_zuletzt timestamptz,
  add column if not exists sellerboard_ek_status text;;

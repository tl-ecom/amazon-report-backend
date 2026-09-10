-- Die Gegenprobe laeuft am 15., nicht am 1.
--
-- Am Monatsersten ist der Vormonat bei Amazon erst zur Haelfte abgerechnet —
-- Vanejas August lag am 10.09. bei 55 % Abdeckung. Ein Abgleich zu diesem
-- Zeitpunkt meldet jeden Monat dieselbe Abweichung bei Gebuehren und Steuer,
-- und nach dem dritten Mal liest niemand mehr hin. Am 15. ist der Vormonat
-- weit genug abgerechnet, dass eine Abweichung etwas bedeutet.
create or replace function internal.cron_sellerboard_abgleich()
returns void
language plpgsql
security definer
set search_path to 'internal', 'public'
as $$
declare
  schluessel text;
begin
  select decrypted_secret into schluessel
  from vault.decrypted_secrets where name = 'service_role_key' limit 1;
  if schluessel is null then
    raise warning 'service_role_key fehlt im Vault — Abgleich uebersprungen';
    return;
  end if;

  perform net.http_post(
    url := 'https://irvnghhxfjjnpodclfuc.supabase.co/functions/v1/sync-sellerboard-abgleich',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || schluessel),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;

select cron.unschedule('sellerboard-abgleich')
where exists (select 1 from cron.job where jobname = 'sellerboard-abgleich');

select cron.schedule('sellerboard-abgleich', '0 6 15 * *',
                     'select internal.cron_sellerboard_abgleich()');;

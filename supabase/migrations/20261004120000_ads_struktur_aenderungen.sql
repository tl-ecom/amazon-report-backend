-- Struktur-Historie fuer das Werbekonto.
--
-- sync-ads-struktur schreibt per Upsert: ads_kampagnen, ads_anzeigengruppen und
-- ads_ziele kennen nur den LETZTEN Stand. Aendert jemand ein Tagesbudget, einen
-- Platzierungs-Modifier oder pausiert eine Kampagne, ist der alte Wert am
-- naechsten Morgen ueberschrieben — und mit ihm die Antwort auf die Frage, was
-- wann geaendert wurde. Jeder Tag ohne diese Spur ist unwiederbringlich.
--
-- Loesung auf Datenbankebene statt in der Function: ein Trigger sieht JEDEN
-- Schreibweg (Tageslauf, Nachzuegler, Handaufruf), ohne dass einer vergessen
-- werden kann.
--
-- ZWEI GRENZEN, die als Spalte mitkommen:
--
-- 1. DATIERUNG. Der Snapshot laeuft einmal taeglich. Eine Aenderung ist deshalb
--    nur auf das Fenster zwischen zwei Laeufen genau: `stand_vorher` bis
--    `erkannt_am`. Zwei Aenderungen im selben Fenster erscheinen als eine.
--
-- 2. KEIN URHEBER. Wer geaendert hat, steht hier nicht — das weiss nur Amazons
--    eigene Aenderungshistorie.

create table if not exists public.ads_struktur_aenderungen (
  id            bigserial primary key,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  marktplatz    text not null,
  -- Stempel des Snapshots, der den neuen Wert gesehen hat.
  erkannt_am    timestamptz not null,
  -- Stempel des Snapshots davor: die Aenderung liegt irgendwo dazwischen.
  stand_vorher  timestamptz,
  ebene         text not null check (ebene in ('kampagne','anzeigengruppe','ziel')),
  objekt_id     text not null,
  campaign_id   text,
  -- Nur bei ebene = 'ziel': keyword, target, negativ_keyword ...
  art           text,
  bezeichnung   text,
  feld          text not null,
  vorher        text,
  nachher       text
);

create index if not exists ads_struktur_aenderungen_lesen
  on public.ads_struktur_aenderungen (tenant_id, marktplatz, erkannt_am desc);

alter table public.ads_struktur_aenderungen enable row level security;

-- Wann ein Ziel zum ersten Mal im Snapshot stand. NULL = war schon da, bevor
-- diese Spalte kam — "unbekannt", nicht "heute". Erst der Default danach gilt
-- fuer neue Zeilen; der Upsert nennt die Spalte nicht und laesst sie stehen.
alter table public.ads_ziele add column if not exists erstmals_gesehen timestamptz;
alter table public.ads_ziele alter column erstmals_gesehen set default now();

-- TG_ARGV: [0] ebene, [1] ID-Spalte, [2..] die ueberwachten Felder.
create or replace function internal.ads_struktur_diff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  alt jsonb := to_jsonb(old);
  neu jsonb := to_jsonb(new);
  f   text;
begin
  for i in 2 .. tg_nargs - 1 loop
    f := tg_argv[i];
    if (alt -> f) is distinct from (neu -> f) then
      insert into public.ads_struktur_aenderungen
        (tenant_id, marktplatz, erkannt_am, stand_vorher, ebene, objekt_id,
         campaign_id, art, bezeichnung, feld, vorher, nachher)
      values
        (new.tenant_id, new.marktplatz, new.gesehen_am, old.gesehen_am, tg_argv[0],
         neu ->> tg_argv[1], neu ->> 'campaign_id', neu ->> 'art',
         coalesce(neu ->> 'name', neu ->> 'text'), f, alt ->> f, neu ->> f);
    end if;
  end loop;
  return new;
exception when others then
  -- Die Spur ist Beiwerk. Sie darf den Snapshot selbst nie zum Scheitern bringen.
  raise warning 'ads_struktur_diff: %', sqlerrm;
  return new;
end;
$$;

revoke all on function internal.ads_struktur_diff() from public, anon, authenticated;

drop trigger if exists ads_kampagnen_diff on public.ads_kampagnen;
create trigger ads_kampagnen_diff
  after update on public.ads_kampagnen
  for each row execute function internal.ads_struktur_diff(
    'kampagne', 'campaign_id',
    'state', 'budget_cents', 'gebots_strategie',
    'mod_top_prozent', 'mod_produktseite_prozent', 'mod_rest_prozent', 'name');

drop trigger if exists ads_anzeigengruppen_diff on public.ads_anzeigengruppen;
create trigger ads_anzeigengruppen_diff
  after update on public.ads_anzeigengruppen
  for each row execute function internal.ads_struktur_diff(
    'anzeigengruppe', 'ad_group_id', 'state', 'standard_gebot_cents');

drop trigger if exists ads_ziele_diff on public.ads_ziele;
create trigger ads_ziele_diff
  after update on public.ads_ziele
  for each row execute function internal.ads_struktur_diff(
    'ziel', 'ziel_id', 'state', 'gebot_cents');

notify pgrst, 'reload schema';

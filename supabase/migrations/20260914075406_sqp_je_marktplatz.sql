-- Der Query-Performance-Bericht lief nur fuer EINEN Marktplatz: den aus
-- auth_contexts.marketplace_id, bei allen Mandanten Amazon.de. Frankreich war
-- damit nicht abrufbar.
--
-- Schlimmer als "nicht moeglich" waere aber gewesen, es einfach zuzulassen: der
-- Primaerschluessel kannte den Marktplatz nicht, ein franzoesischer Abruf haette
-- die deutschen Zeilen derselben ASIN und Woche ueberschrieben. Suchbegriffe,
-- CTR und Kaufanteil sind je Land voellig verschieden — das waere still falsch
-- geworden, nicht sichtbar kaputt.
--
-- Deshalb wird der Marktplatz hier zur echten Dimension: eigene Spalte, Teil des
-- Schluessels, und die vorhandenen Zeilen bekommen den Marktplatz, unter dem sie
-- tatsaechlich abgerufen wurden.

alter table public.sqp_rows   add column if not exists marktplatz text;
alter table public.sqp_laeufe add column if not exists marktplatz text;

-- Bestand nachtragen: alles Bisherige kam ueber den Marktplatz der Verbindung.
update public.sqp_rows r
   set marktplatz = ac.marketplace_id
  from public.auth_contexts ac
 where ac.tenant_id = r.tenant_id and ac.source = 'sp' and r.marktplatz is null;

update public.sqp_laeufe l
   set marktplatz = ac.marketplace_id
  from public.auth_contexts ac
 where ac.tenant_id = l.tenant_id and ac.source = 'sp' and l.marktplatz is null;

-- Sollte eine Zeile ohne Verbindung uebrig sein, bleibt sie nicht namenlos:
-- Amazon.de ist der belegte Fall, alles andere gab es bisher nicht.
update public.sqp_rows   set marktplatz = 'A1PA6795UKMFR9' where marktplatz is null;
update public.sqp_laeufe set marktplatz = 'A1PA6795UKMFR9' where marktplatz is null;

alter table public.sqp_rows   alter column marktplatz set not null;
alter table public.sqp_laeufe alter column marktplatz set not null;

-- Schluessel neu: ohne den Marktplatz darin wuerde Frankreich Deutschland
-- ueberschreiben, sobald der erste franzoesische Abruf laeuft.
alter table public.sqp_rows   drop constraint if exists sqp_rows_pkey;
alter table public.sqp_laeufe drop constraint if exists sqp_laeufe_pkey;

alter table public.sqp_rows
  add constraint sqp_rows_pkey
  primary key (tenant_id, marktplatz, asin, periode, zeitraum_von, search_query);

alter table public.sqp_laeufe
  add constraint sqp_laeufe_pkey
  primary key (tenant_id, marktplatz, asin, periode, zeitraum_von);

comment on column public.sqp_rows.marktplatz is
  'Amazon-Marketplace-ID, unter der dieser Bericht abgerufen wurde. Suchbegriffe und Kaufanteile sind je Land verschieden.';
comment on column public.sqp_laeufe.marktplatz is
  'Amazon-Marketplace-ID des Abrufs.';

notify pgrst, 'reload schema';

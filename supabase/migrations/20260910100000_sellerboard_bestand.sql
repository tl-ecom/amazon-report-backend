-- Externe Bestaende (Sellerboard-Feed): eigenes Lager, Prep Center, 3PL,
-- bestellte Ware, AWD — alles, was Amazon nicht sieht.
--
-- Drei Tabellen:
--   bestand_verbindungen   je Mandant und Quelle: Vault-Referenz auf die Feed-URL,
--                          Status, letzter Versuch/Erfolg, Auto-Sync-Einstellung.
--                          Die URL selbst liegt NUR im Vault (sie traegt ein Token).
--   bestand_extern         aktueller Stand je (Quelle, Marktplatz, SKU, ASIN,
--                          Lagerart, Lagername). Wird je Sync vollstaendig ersetzt.
--   bestand_extern_verlauf Tagesstand mit EK und Wert — Grundlage fuer
--                          Kapitalbindung ueber die Zeit (Working Capital).
--
-- Amazon (SP-API) bleibt fuer FBA und Inbound die primaere Quelle. Die
-- Doppelzaehlung wird NICHT hier, sondern an einer Stelle im Code verhindert
-- (_shared/bestand_gesamt.ts): Zeilen der Klasse "amazon" aus Sellerboard
-- werden nur gezaehlt, wenn Amazon fuer den Mandanten gar nichts liefert.

create table if not exists public.bestand_verbindungen (
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  quelle             text not null default 'sellerboard',
  url_secret         uuid,                                  -- Vault-Referenz, nie die URL
  status             text not null default 'nicht_verbunden' -- nicht_verbunden | ungeprueft | verbunden | fehler
    check (status in ('nicht_verbunden', 'ungeprueft', 'verbunden', 'fehler')),
  auto_sync          boolean not null default true,
  intervall_stunden  integer not null default 6 check (intervall_stunden between 1 and 168),
  zuletzt_versuch    timestamptz,
  zuletzt_erfolg     timestamptz,
  letzter_fehler     text,
  erkannte_spalten   jsonb,                                 -- Ergebnis der Spaltenerkennung
  zeilen_zuletzt     integer,
  je_lagerart        jsonb,                                 -- Summe je Lagerart, letzter Erfolg
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, quelle)
);
alter table public.bestand_verbindungen enable row level security;
-- Bewusst keine Policies: Zugriff ausschliesslich ueber die Functions (service_role).

create table if not exists public.bestand_extern (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  quelle          text not null,
  marketplace_id  text,                       -- Amazon-Marktplatz-ID, wenn erkannt
  marktplatz_roh  text not null default '',   -- wie im Feed ('amazon.de', 'DE', ...)
  sku             text not null default '',
  asin            text not null default '',   -- '' = nicht zuordenbar (wird nicht gezaehlt)
  lagerart        text not null check (lagerart in (
                    'fba_verfuegbar', 'fba_reserviert', 'fba_unverkaeuflich', 'inbound_fba',
                    'awd', 'prep_center', 'extern_lager', 'dreipl', 'ordered', 'sonstige_pipeline')),
  lagername       text not null,              -- Spaltenname bzw. Lagerort im Feed
  menge           integer,                    -- null = Feld leer (UNBEKANNT), nie 0 erfunden
  zuordnung       text not null default 'keine' check (zuordnung in ('sku', 'asin', 'keine')),
  produktname     text,
  stand           timestamptz not null default now(),
  sync_id         uuid,                       -- Lauf, der die Zeile zuletzt bestaetigt hat
  primary key (tenant_id, quelle, marktplatz_roh, sku, asin, lagerart, lagername)
);
create index if not exists bestand_extern_asin_idx on public.bestand_extern (tenant_id, asin);
alter table public.bestand_extern enable row level security;

create table if not exists public.bestand_extern_verlauf (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  datum           date not null,
  quelle          text not null,
  marktplatz_roh  text not null default '',
  sku             text not null default '',
  asin            text not null default '',
  lagerart        text not null,
  lagername       text not null,
  menge           integer,
  ek_cents        integer,                    -- EK zum Zeitpunkt der Messung, null = unbekannt
  wert_cents      bigint,                     -- menge * ek_cents, null wenn EK fehlt
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, datum, quelle, marktplatz_roh, sku, asin, lagerart, lagername)
);
create index if not exists bestand_extern_verlauf_asin_idx on public.bestand_extern_verlauf (tenant_id, asin, datum);
create index if not exists bestand_extern_verlauf_datum_idx on public.bestand_extern_verlauf (tenant_id, datum);
alter table public.bestand_extern_verlauf enable row level security;

comment on table public.bestand_verbindungen is
  'Externe Bestandsquellen je Mandant (z. B. Sellerboard-Feed). url_secret verweist auf den Vault; die URL steht nie im Klartext.';
comment on table public.bestand_extern is
  'Aktueller externer Bestand je SKU/ASIN, Lagerart und Lagerort. Amazon-Klasse (fba_*, inbound_fba) wird nur ohne SP-API-Daten gezaehlt.';
comment on table public.bestand_extern_verlauf is
  'Tagesstand der externen Bestaende mit EK und Wert — fuer Kapitalbindung ueber die Zeit.';

-- Neuer Menuepunkt "Bestand" (vereinheitlichte Bestandssicht). Der Tab-Name ist
-- der Feature-Schluessel; fehlt er, ist der Tab fuer Teilnehmer unsichtbar.
-- Voreinstellung wie ueblich: im Coaching-Tarif an, sonst aus.
update public.tarif_features t
set features = t.features || jsonb_build_object('bestand', t.tarif = 'coaching')
where not (t.features ? 'bestand');

notify pgrst, 'reload schema';

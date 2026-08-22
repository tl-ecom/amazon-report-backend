-- Amazons Gebührentabelle ist NICHT eine Zeile je Größenklasse, sondern
-- Klasse × Gewichtsstufe (StandardParcel bis 250 g, bis 500 g, ...). Der reale
-- Vaneja-Bestand zeigt das: in StandardParcel liegen Gebühren von 4,01 bis 6,12 €.
-- Der Schlüssel muss die Gewichtsstufe daher enthalten, sonst passt nur eine
-- einzige Zeile je Klasse hinein und alle anderen Stufen gehen verloren.
alter table public.fee_schedule
  drop constraint if exists fee_schedule_marketplace_size_tier_gueltig_ab_key;

-- max_weight_g NULL = oberste Stufe ohne Obergrenze. In einem UNIQUE-Index sind
-- mehrere NULLs erlaubt, deshalb NULLS NOT DISTINCT: genau eine offene Stufe.
create unique index if not exists fee_schedule_stufe_idx
  on public.fee_schedule (marketplace, size_tier, gueltig_ab, max_weight_g)
  nulls not distinct;

comment on column public.fee_schedule.max_weight_g is
  'Obergrenze der Gewichtsstufe innerhalb der Groessenklasse. NULL = oberste Stufe ohne Obergrenze.';;

-- Die wichtigsten Begriffe eines Produkts sind die, ueber die gekauft wird —
-- nicht die mit dem groessten Suchvolumen. Nach Volumen stand bei der Etagere
-- "deko wohnzimmer" (34.566 Suchen, kein Kauf) ganz oben. Rang jetzt nach
-- Volumen x Kaufanteil in der besten Woche des Begriffs, also auch Begriffe,
-- die frueher trugen und heute nicht mehr.
do $$
declare
  def text := pg_get_functiondef('public.sqp_produkt_verlauf(uuid, text, integer)'::regprocedure);
  alt constant text := $a$  top as (
    select produkt, begriff, volumen,
           row_number() over (partition by produkt order by volumen desc, begriff) as rang
      from pw join n_wochen n using (produkt)
     where pw.von = n.letzte
  )$a$;
  neu text;
begin
  neu := replace(def, alt, $a$  top as (
    select produkt, begriff,
           row_number() over (partition by produkt
                              order by max(volumen * kaufanteil) desc, max(volumen) desc, begriff) as rang
      from pw
     group by produkt, begriff
  )$a$);
  if neu = def then raise exception 'Einfuegestelle nicht gefunden'; end if;
  execute neu;
end $$;

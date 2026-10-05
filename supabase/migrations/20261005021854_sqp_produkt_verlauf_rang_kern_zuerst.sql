-- Der Rang nach Volumen x Kaufanteil der besten Woche holte Zufallstreffer
-- nach oben: ein Begriff mit einem einzigen Kauf hat 100 % Kaufanteil
-- ("weearth komposter" vor "biomülleimer küche"). Jetzt: zuerst die
-- Kernbegriffe (in jeder Woche vorhanden), darin nach der Summe ueber alle
-- Wochen und nur aus Wochen mit belastbarer eigener Datenbasis (nicht duenn).
do $$
declare
  def text := pg_get_functiondef('public.sqp_produkt_verlauf(uuid, text, integer)'::regprocedure);
  alt constant text := $a$                              order by max(volumen * kaufanteil) desc, max(volumen) desc, begriff) as rang
      from pw
     group by produkt, begriff$a$;
  neu text;
begin
  neu := replace(def, alt, $a$                              order by (count(*) = max(n.n)) desc,
                                       coalesce(sum(volumen * kaufanteil) filter (where not duenn), 0) desc,
                                       max(volumen) desc, begriff) as rang
      from pw join n_wochen n using (produkt)
     group by produkt, begriff$a$);
  if neu = def then raise exception 'Einfuegestelle nicht gefunden'; end if;
  execute neu;
end $$;

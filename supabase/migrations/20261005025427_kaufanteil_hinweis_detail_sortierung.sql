-- "order by 2 - 3" sortiert nicht nach Spalte 2 minus Spalte 3, sondern nach
-- der Konstanten -1: Ordnungszahlen gelten nur allein, nicht in Ausdruecken.
-- Dadurch wurde irgendeine Kampagne gewaehlt statt der mit dem groessten
-- Klickverlust, und der Satz zur Kampagne fehlte im Hinweis.
do $$
declare
  def text := pg_get_functiondef('public.kaufanteil_hinweis_detail(uuid, text, text)'::regprocedure);
  neu text;
begin
  neu := replace(def, $a$     order by 2 - 3 desc
     limit 1
  )$a$, $a$     order by coalesce(sum((z ->> 'klicks')::int) filter (where (z ->> 'von')::date = top.best_von), 0)
            - coalesce(sum((z ->> 'klicks')::int) filter (where (z ->> 'von')::date = letzte.von), 0) desc
     limit 1
  )$a$);
  if neu = def then raise exception 'Einfuegestelle nicht gefunden'; end if;
  execute neu;
end $$;

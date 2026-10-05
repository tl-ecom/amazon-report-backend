-- Der Listing-Status gilt je SKU. "Listing inaktiv" klingt, als waere das
-- Produkt weg — dabei kann ein zweites Angebot derselben ASIN weiterlaufen.
-- Der Text wird an der Quelle geaendert, damit Diagramm, Werkzeug und
-- Tagesmail dasselbe sagen. Nur die zwei Textbausteine, sonst nichts.
do $$
declare
  def text := pg_get_functiondef('public.ads_produkt_ereignisse(uuid, text, integer)'::regprocedure);
  neu text;
begin
  neu := replace(replace(def,
    $a$'Listing inaktiv (%s)'$a$, $a$'Ein Angebot inaktiv (%s)'$a$),
    $a$'Listing wieder aktiv (%s)'$a$, $a$'Ein Angebot wieder aktiv (%s)'$a$);
  if neu = def then raise exception 'Textbausteine nicht gefunden'; end if;
  execute neu;
end $$;

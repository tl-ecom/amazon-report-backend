-- Kaufanteil je Suchbegriff bekommt die Werbung derselben Woche dazu: Klicks,
-- Bestellungen und Kosten, die die Kampagnen des Produkts (ads_steuerung)
-- ueber genau diesen Suchbegriff hatten (ads_suchbegriffe_daily, nur
-- Sponsored Products). Faellt der Kaufanteil MIT den Werbeklicks, liegt es
-- nahe an der Werbung; faellt er bei gleichen Klicks, sind es die Kaeufe
-- ohne Werbung oder die Konversion.
--
-- Wochen vor dem ersten Tag mit Suchbegriff-Daten bekommen null, nicht 0.
-- Vier Einfuegungen in die bestehende Funktion; jede wird geprueft.
do $$
declare
  def text := pg_get_functiondef('public.sqp_produkt_verlauf(uuid, text, integer)'::regprocedure);
  s text := def;
  v text;
begin
  -- 1) Baustein "werbung" vor "wochen".
  v := replace(s, $a$  wochen as (select produkt, von, max(bis) as bis, count(*) as begriffe from pw group by 1, 2),$a$,
$a$  sb_ab as (
    select min(datum) as d from public.ads_suchbegriffe_daily
     where tenant_id = p_tenant and marktplatz = p_marktplatz
  ),
  werbung as (
    select pw.produkt, pw.von, pw.begriff,
           sum(a.clicks) as klicks, sum(a.orders) as bestellungen, sum(a.spend_cents) as spend_cents
      from pw
      join public.ads_steuerung st on st.tenant_id = p_tenant and st.produkt = pw.produkt and st.modus <> 'nur_analyse'
      join public.ads_suchbegriffe_daily a on a.tenant_id = p_tenant and a.marktplatz = p_marktplatz
                                          and a.campaign_id = st.campaign_id
                                          and lower(a.suchbegriff) = lower(pw.begriff)
                                          and a.datum between pw.von and pw.bis
     group by 1, 2, 3
  ),
  wochen as (select produkt, von, max(bis) as bis, count(*) as begriffe from pw group by 1, 2),$a$);
  if v = s then raise exception 'Einfuegestelle 1 nicht gefunden'; end if; s := v;

  -- 2) Kern je Woche: Werbeklicks und -bestellungen der Kernbegriffe.
  v := replace(s, $a$           sum(pw.volumen * pw.kaufanteil) / nullif(sum(pw.volumen), 0) as kaufanteil
      from pw join kern k on k.produkt = pw.produkt and k.begriff = pw.begriff
     group by 1, 2$a$,
$a$           sum(pw.volumen * pw.kaufanteil) / nullif(sum(pw.volumen), 0) as kaufanteil,
           case when pw.von >= (select d from sb_ab) then coalesce(sum(wb.klicks), 0) end as werbeklicks,
           case when pw.von >= (select d from sb_ab) then coalesce(sum(wb.bestellungen), 0) end as werbebestellungen
      from pw join kern k on k.produkt = pw.produkt and k.begriff = pw.begriff
      left join werbung wb on wb.produkt = pw.produkt and wb.von = pw.von and wb.begriff = pw.begriff
     group by 1, 2$a$);
  if v = s then raise exception 'Einfuegestelle 2 nicht gefunden'; end if; s := v;

  v := replace(s, $a$'kern_volumen', kw.volumen, 'kern_kaufanteil', round(kw.kaufanteil::numeric, 2))$a$,
$a$'kern_volumen', kw.volumen, 'kern_kaufanteil', round(kw.kaufanteil::numeric, 2),
                        'kern_werbeklicks', kw.werbeklicks, 'kern_werbebestellungen', kw.werbebestellungen)$a$);
  if v = s then raise exception 'Einfuegestelle 3 nicht gefunden'; end if; s := v;

  -- 3) Je Begriff und Woche.
  v := replace(s, $a$                                               'kaufanteil', pw.kaufanteil, 'duenn', pw.duenn) order by pw.von)
                                       from pw where pw.produkt = t.produkt and pw.begriff = t.begriff))$a$,
$a$                                               'kaufanteil', pw.kaufanteil, 'duenn', pw.duenn,
                                               'werbeklicks', case when pw.von >= (select d from sb_ab) then coalesce(wb.klicks, 0) end,
                                               'werbebestellungen', case when pw.von >= (select d from sb_ab) then coalesce(wb.bestellungen, 0) end,
                                               'werbekosten_cents', case when pw.von >= (select d from sb_ab) then coalesce(wb.spend_cents, 0) end)
                                             order by pw.von)
                                       from pw
                                       left join werbung wb on wb.produkt = pw.produkt and wb.von = pw.von and wb.begriff = pw.begriff
                                      where pw.produkt = t.produkt and pw.begriff = t.begriff))$a$);
  if v = s then raise exception 'Einfuegestelle 4 nicht gefunden'; end if; s := v;

  execute s;
end $$;

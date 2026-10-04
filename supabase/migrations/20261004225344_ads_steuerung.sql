-- Wer steuert welche Kampagne: Helium 10 (Gebots-KI), Pulse oder niemand.
-- Regel (05.10.2026): Pulse steuert nur die verwalteten Produkte. Wo die
-- Helium-10-KI Gebote setzt, fasst Pulse kein Gebot an (sonst ueberschreibt
-- die KI es am naechsten Tag). Hat ein Mandant hier Zeilen, gilt jede NICHT
-- gelistete Kampagne als nur_analyse. Mandanten ohne Zeilen sind unberuehrt.
create table public.ads_steuerung (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id text not null,
  produkt text,
  modus text not null check (modus in ('h10', 'pulse', 'nur_analyse')),
  grund text,
  geprueft_am date not null default current_date,
  primary key (tenant_id, campaign_id)
);
alter table public.ads_steuerung enable row level security; -- nur Service-Rolle

insert into public.ads_steuerung (tenant_id, campaign_id, produkt, modus, grund)
select '4c331e70-809d-4590-a587-1e917f9db6ca', v.id, v.produkt, v.modus,
  case v.modus when 'h10' then 'Helium-10-KI hat 25.09.–05.10.2026 Gebote gesetzt'
               else 'keine Gebotsaenderung der Helium-10-KI 25.09.–05.10.2026' end
from (values
  -- Biomuelleimer: keine einzige KI-Aenderung
  ('11909007832289','Biomülleimer','pulse'),('57247394208299','Biomülleimer','pulse'),
  ('67879307274464','Biomülleimer','pulse'),('79676343855885','Biomülleimer','pulse'),
  ('95040867776815','Biomülleimer','pulse'),('102049191376153','Biomülleimer','pulse'),
  ('110065670315212','Biomülleimer','pulse'),('117077710112917','Biomülleimer','pulse'),
  ('122131778974893','Biomülleimer','pulse'),('158875703849539','Biomülleimer','pulse'),
  ('178785037208042','Biomülleimer','pulse'),('216956566774353','Biomülleimer','pulse'),
  ('224358474121845','Biomülleimer','pulse'),('236515710932745','Biomülleimer','pulse'),
  ('254095055931403','Biomülleimer','pulse'),('260772909460810','Biomülleimer','pulse'),
  ('272270980145589','Biomülleimer','pulse'),
  -- Kratzbrett
  ('73629374607420','Kratzbrett','h10'),('164305195090718','Kratzbrett','h10'),
  ('430491681196998','Kratzbrett','h10'),('434906740098748','Kratzbrett','h10'),
  ('471669746039624','Kratzbrett','h10'),('512594536397313','Kratzbrett','h10'),
  ('547372538189567','Kratzbrett','h10'),('560999216254376','Kratzbrett','h10'),
  ('118881592562675','Kratzbrett','pulse'),('189549836959980','Kratzbrett','pulse'),
  ('200998669434685','Kratzbrett','pulse'),('257136626693607','Kratzbrett','pulse'),
  ('279139361979795','Kratzbrett','pulse'),('309977512424284','Kratzbrett','pulse'),
  ('462233229152115','Kratzbrett','pulse'),('512260655133503','Kratzbrett','pulse'),
  -- Etagere DE
  ('106560911758029','Etagere','h10'),('213045332585889','Etagere','h10'),
  ('266074215256979','Etagere','h10'),('322991127557757','Etagere','h10'),
  ('417094441748101','Etagere','h10'),('430285296414559','Etagere','h10'),
  ('433649803072999','Etagere','h10'),('521691869415537','Etagere','h10'),
  ('11725121073102','Etagere','pulse'),('27721741566735','Etagere','pulse'),
  ('83805603206471','Etagere','pulse'),('149862902115670','Etagere','pulse'),
  ('191112485095622','Etagere','pulse'),('240604931204794','Etagere','pulse'),
  ('307842859238402','Etagere','pulse'),('406158703778790','Etagere','pulse'),
  ('407687643935255','Etagere','pulse'),
  -- Etagere FR: keine KI-Aenderung
  ('14538982315179','Etagere','pulse'),('140598533634730','Etagere','pulse'),
  ('159526563722064','Etagere','pulse'),('210507872494297','Etagere','pulse'),
  ('233701290763438','Etagere','pulse'),('235808836585153','Etagere','pulse'),
  ('236420977749281','Etagere','pulse'),('244371912792213','Etagere','pulse'),
  -- Kauknochen (Kaffeeholz)
  ('65633335614199','Kauknochen','h10'),('80327242319171','Kauknochen','h10'),
  ('171809534828316','Kauknochen','h10'),('276926996855206','Kauknochen','h10'),
  ('7522566819060','Kauknochen','pulse'),('30870411440035','Kauknochen','pulse'),
  ('35369432892742','Kauknochen','pulse'),('47930232074678','Kauknochen','pulse'),
  ('55634171396698','Kauknochen','pulse'),('69998568051448','Kauknochen','pulse'),
  ('115309903241727','Kauknochen','pulse'),('135617892399711','Kauknochen','pulse'),
  ('182352971343252','Kauknochen','pulse'),('237765710660654','Kauknochen','pulse'),
  ('276227475646904','Kauknochen','pulse')
) as v(id, produkt, modus);

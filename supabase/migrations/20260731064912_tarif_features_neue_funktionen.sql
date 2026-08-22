-- Neue Funktionen in die Tarif-Matrix aufnehmen: Strategie-Pfad, Board-Report,
-- Erstattungen, Nachschub, Ladenhüter, MCP-Zugang.
-- Startwerte (jederzeit im Admin-Tab umschaltbar):
--   coaching: alles an  -> e-One/Vaneja (beide coaching) verlieren nichts.
--   vip:      die Geld-Radare + MCP an, Coaching-Kern (Strategie/Board) aus.
--   premium:  alles neue aus.
update public.tarif_features
set features = features || '{"strategie":true,"board":true,"erstattungen":true,"nachschub":true,"ladenhueter":true,"mcp":true}'::jsonb
where tarif = 'coaching';

update public.tarif_features
set features = features || '{"strategie":false,"board":false,"erstattungen":true,"nachschub":true,"ladenhueter":true,"mcp":true}'::jsonb
where tarif = 'vip';

update public.tarif_features
set features = features || '{"strategie":false,"board":false,"erstattungen":false,"nachschub":false,"ladenhueter":false,"mcp":false}'::jsonb
where tarif = 'premium';;

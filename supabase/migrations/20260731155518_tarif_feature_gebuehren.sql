-- Fee Decoder als eigenes Feature. Coaching bekommt es (dort lebt die
-- Maßnahmenarbeit), premium und vip vorerst nicht — schaltbar in der Matrix.
update public.tarif_features
set features = features || jsonb_build_object('gebuehren', tarif = 'coaching')
where not (features ? 'gebuehren');;

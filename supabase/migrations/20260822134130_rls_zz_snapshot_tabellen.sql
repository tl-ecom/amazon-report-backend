-- Die beiden Sicherungskopien vom 19.08.2026 hatten als einzige Tabellen RLS aus und waren
-- damit ueber den anon-Key voll lesbar. Nach Hauskonvention: RLS an, KEINE Policies —
-- der Zugriff laeuft ausschliesslich ueber service_role, das RLS ohnehin umgeht.
alter table public.zz_snapshot_finance_gebuehren_20260819 enable row level security;
alter table public.zz_snapshot_finance_monatlich_20260819 enable row level security;

comment on table public.zz_snapshot_finance_gebuehren_20260819 is
  'Sicherungskopie finance_gebuehren vom 19.08.2026. RLS an ohne Policies (Hauskonvention), Zugriff nur via service_role.';
comment on table public.zz_snapshot_finance_monatlich_20260819 is
  'Sicherungskopie finance_monatlich vom 19.08.2026. RLS an ohne Policies (Hauskonvention), Zugriff nur via service_role.';

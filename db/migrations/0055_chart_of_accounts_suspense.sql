-- Additional suspense accounts for future reconciliation lanes.
--
-- Originally written against a chart_of_accounts shape that never existed
-- (code / account_type / description, kind 'suspense'); 0007 defines
-- (id, name, kind) with kind IN ('asset','liability','revenue'), so this
-- migration failed on every fresh database. Rewritten to the real schema,
-- modelling suspense the way 0007 already does for scheme_rounding_residue
-- (kind 'asset').
INSERT INTO chart_of_accounts (id, name, kind) VALUES
    ('fx_rounding_difference', 'FX rounding difference (suspense)', 'asset'),
    ('chargeback_suspense',    'Chargeback suspense',               'asset')
ON CONFLICT (id) DO NOTHING;

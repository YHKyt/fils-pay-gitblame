-- pay.ts resolves a payment link's prior authorize attempts by their
-- idempotency key, which always has the shape
--   paylink:<link id>:<client key>:authorize
-- so both capturedAttemptExists (the claim UPDATE's NOT EXISTS guard, run on
-- every pay) and voidOtherLinkAuthorizations filter the table with
--   merchant_id = $1 AND endpoint = 'transactions.authorize'
--   AND key LIKE 'paylink:<link id>:%:authorize'
-- The UNIQUE (merchant_id, endpoint, key) index cannot serve the LIKE: its
-- default (locale) collation is not usable for pattern prefixes, so the
-- planner falls back to a sequential scan of idempotency_keys. That scan
-- costs ~23 ms per pay at ~46k rows and only grows, dragging pay throughput
-- from ~45/s down to ~25/s after 20k pays.
--
-- The LIKE pattern is left-anchored on the constant prefix
-- 'paylink:<link id>:' (the % is only after it), so a btree with
-- text_pattern_ops on key lets the planner turn the LIKE into a range scan
-- over that prefix. Leading the index with the two equality columns keeps it
-- selective for both call sites; no query change is needed.
--
-- A plain CREATE INDEX: db/migrate.ts runs each file in a transaction, where
-- CONCURRENTLY is not allowed. It briefly blocks writes to idempotency_keys
-- while it builds, which is fast at this table's size and safe on a populated
-- database.

CREATE INDEX idx_idempotency_keys_paylink_like
    ON idempotency_keys (merchant_id, endpoint, key text_pattern_ops);

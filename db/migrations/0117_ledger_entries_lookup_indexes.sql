-- ledger_entries is the largest table (every capture, refund, payout and
-- correction appends legs) and had only (merchant_id, occurred_at). Two hot
-- lookups could not use it and seq-scanned the whole ledger.
--
-- entry_group_id: the deferred constraint trigger ledger_entries_balance
-- (0007, check_ledger_group_balance) sums the group of every inserted leg at
-- COMMIT. Without an index each leg is a full scan, so a capture (2-4 legs),
-- a refund and every batch close commit in time proportional to the whole
-- ledger, while still holding their row locks. The reconciliation report's
-- NOT EXISTS / EXISTS probes by entry_group_id (settlement/query.ts) use it
-- too.
--
-- A plain CREATE INDEX: db/migrate.ts runs each file in a transaction, where
-- CONCURRENTLY is not allowed. It blocks ledger writes only while it builds
-- (about 1.5 s for 1.5 million rows).

CREATE INDEX idx_ledger_entries_entry_group ON ledger_entries (entry_group_id);

-- transaction_id: every refund reads the fee the transaction was charged
-- from its platform_fee_revenue legs (payments/processRefund.ts) while it
-- holds the transaction's row lock. Without an index that is a full ledger
-- scan per refund (about 90-100 ms at 1.5 million rows, 0.2 ms with it).
CREATE INDEX idx_ledger_entries_transaction ON ledger_entries (transaction_id);

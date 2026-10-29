-- Backs GET /v1/settlement/batches/:id (apps/api/src/settlement/query.ts,
-- getSettlementBatch): count(*) of transaction_events WHERE
-- settlement_batch_id = $1. 0023 added the column and its FK but only a
-- partial index on the IS NULL side, so every batch detail read seq-scanned
-- the whole events table. Partial on IS NOT NULL: unbatched rows (the
-- write-hot ones) never enter this index until CloseBatch claims them.

CREATE INDEX idx_transaction_events_settlement_batch
    ON transaction_events (settlement_batch_id)
    WHERE settlement_batch_id IS NOT NULL;

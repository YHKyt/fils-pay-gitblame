-- Backs GET /v1/settlement/summary (apps/api/src/settlement/query.ts,
-- getSettlementSummary): capture-type events in an occurred_at window,
-- batched or not. The only existing occurred_at index on transaction_events
-- (0023's idx_transaction_events_unbatched) is partial on
-- settlement_batch_id IS NULL, so it cannot serve a window that includes
-- batched events, and 0018's (transaction_id, occurred_at) cannot be range-
-- scanned without a transaction_id. Without this the summary seq-scans the
-- whole table on every request. INCLUDE lets the summary run index-only.

CREATE INDEX idx_transaction_events_capture_occurred
    ON transaction_events (occurred_at)
    INCLUDE (transaction_id, amount_fils)
    WHERE event_type IN ('captured', 'partially_captured');

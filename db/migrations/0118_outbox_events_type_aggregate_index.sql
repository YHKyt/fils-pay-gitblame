-- EnqueuePayoutNotifications (apps/settlement/internal/settlement/payout_notify.go)
-- runs on every settlement daemon tick (60 s by default) and looks up
-- settlement.paid events by (event_type, aggregate_id) twice: the scan
-- anti-joins every paid batch against them, and each insert re-checks its
-- batch under an advisory lock. outbox_events had no index for that lookup
-- (only 0009's unprocessed-id and 0096's (xact_id, id) indexes), so both
-- read the whole table: one sequential scan per tick and one more per event
-- inserted, each growing with the outbox's entire history.
--
-- A plain CREATE INDEX: db/migrate.ts runs each file in a transaction, where
-- CONCURRENTLY is not allowed, so it blocks outbox inserts (every write that
-- enqueues an event) while it builds. On a large outbox, build it beforehand
-- with CREATE INDEX CONCURRENTLY IF NOT EXISTS under this same name and
-- columns; this file then does nothing.

CREATE INDEX IF NOT EXISTS idx_outbox_events_type_aggregate ON outbox_events (event_type, aggregate_id);

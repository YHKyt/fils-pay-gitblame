-- Webhook dispatcher Step A (apps/api/src/webhooks/dispatcher.ts) looked for
-- missing deliveries by anti-joining EVERY eligible outbox event against
-- webhook_deliveries on every pass (every 5 s and on every NOTIFY): 70 ms at
-- 115k events, 1-2 s at 460k (perfload), growing with the outbox history.
--
-- One row per endpoint, written by the pass that last handled it while it
-- was active: every eligible event with id < below_id whose inserting
-- transaction is below below_xmin (pg_snapshot_xmin of that pass's
-- snapshot) already has its delivery row for this endpoint. Such a
-- transaction had finished before that snapshot, so the pass saw the event;
-- a lower id that committed later has a higher xact_id and is still read.
-- Step A skips only what every active endpoint's row covers, so an endpoint
-- with no row (new, or never active during a pass) keeps the full scan
-- until a pass has handled it, and a disabled endpoint's row stays where it
-- was, so on re-enable its events from the disabled period are found.
--
-- outbox_events.xact_id and its index come from 0096.
CREATE TABLE webhook_step_a_watermarks (
    endpoint_id UUID PRIMARY KEY REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
    below_id    BIGINT NOT NULL,
    below_xmin  xid8 NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

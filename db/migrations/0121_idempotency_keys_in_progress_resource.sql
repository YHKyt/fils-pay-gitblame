-- authorize and capture now commit their idempotency claim before the
-- acquirer call, so that no pool connection is held while the acquirer runs.
-- A capture at the acquirer reserves its amount on that in_progress claim
-- (resource_id = the transaction), and every capture and void of the same
-- transaction sums those reservations (activeCaptureReservationFils in
-- apps/api/src/payments/idempotency.ts). This partial index keeps that lookup
-- off the whole table: only claims still in progress are in it, a handful at
-- any time, however many completed keys accumulate.
--
-- Plain CREATE INDEX because db/migrate.ts runs each file in a transaction;
-- it blocks writes to idempotency_keys only while it builds.
CREATE INDEX idx_idempotency_keys_in_progress_resource
    ON idempotency_keys (resource_id)
 WHERE status = 'in_progress';

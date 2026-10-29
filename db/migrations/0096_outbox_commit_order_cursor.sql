-- Reporting consumed outbox_events with `WHERE id > cursor ORDER BY id`. An id
-- is drawn from the sequence when a row is INSERTed, not when its transaction
-- COMMITs, so ids become visible out of order: a transaction holding id 13
-- that commits after id 14 was consumed is skipped forever.
--
-- xact_id records the transaction that inserted the row. The consumer reads
-- only rows whose xact_id is below its snapshot's xmin and orders them by
-- (xact_id, id). Every transaction below xmin has already committed or
-- aborted, so that prefix is final: nothing can commit into it later, and
-- the cursor can never step past an event it has not seen.
--
-- Existing rows get the constant '0' (a metadata-only default, no table
-- rewrite). They were all committed before this ALTER obtained its lock, and
-- they sort ahead of every new row in their old id order. New rows take the
-- real id of their inserting transaction (always the top-level one).
ALTER TABLE outbox_events ADD COLUMN xact_id xid8 NOT NULL DEFAULT '0';
ALTER TABLE outbox_events ALTER COLUMN xact_id SET DEFAULT pg_current_xact_id();

CREATE INDEX idx_outbox_events_xact_id_id ON outbox_events (xact_id, id);

-- The reporting cursor becomes a (xact_id, id) position. An existing
-- watermark N carries over as ('0', N): the same legacy rows count as
-- consumed as before.
ALTER TABLE reporting_outbox_cursor ADD COLUMN last_processed_xact_id xid8 NOT NULL DEFAULT '0';

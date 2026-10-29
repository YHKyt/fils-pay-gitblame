-- FP-201 was marked fixed ("dedupe on callbackId via processed_events") but
-- no processed_events table or check was ever shipped: every redelivered
-- acquirer callback appended another note. Make callback_id unique so the
-- insert can be ON CONFLICT DO NOTHING (safe under concurrent redelivery).
-- Existing duplicates are byte-for-byte redeliveries of the same verdict;
-- keep the earliest of each.

DELETE FROM acquirer_callback_notes n
 USING acquirer_callback_notes keep
 WHERE n.callback_id = keep.callback_id
   AND (n.created_at, n.id) > (keep.created_at, keep.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);

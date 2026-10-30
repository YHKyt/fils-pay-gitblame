-- A capture whose acquirer call throws (a timeout: the acquirer may already
-- have captured) used to roll back without a trace. Only a same-key retry
-- was safe (it resends the same acquirer key, so the acquirer replays its
-- answer). Anything else that came next acted as if nothing had happened:
--   * a capture under another Idempotency-Key sent a new acquirer key and
--     captured the card a second time, while the database recorded one;
--   * a void marked the transaction voided while the acquirer had captured.
-- (docs/audit/concfuzz.md, "Residual: another operation after a thrown
-- capture".)
--
-- capture.ts now commits one row here, in the same transaction as the failed
-- claim, when the acquirer call throws. While it exists:
--   * a capture of the same amount, under any key, resends THIS acquirer key
--     (the acquirer replays: one capture, whatever happened the first time)
--     and deletes the row when the acquirer answers;
--   * a capture of another amount and a void are refused with 409
--     capture_outcome_unknown.
-- The original claim is completed with the resolving answer, so a later
-- retry of the first key replays it instead of capturing again.
CREATE TABLE capture_attempts_unresolved (
    transaction_id           UUID PRIMARY KEY REFERENCES transactions (id),
    idempotency_key_id       UUID NOT NULL REFERENCES idempotency_keys (id),
    amount_fils              BIGINT NOT NULL CHECK (amount_fils > 0),
    acquirer_idempotency_key TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

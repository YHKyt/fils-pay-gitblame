-- settlement_payout_disbursements is "one row per paid batch" (0057), but
-- nothing enforced it, and the 2026-08-21 incident (docs/ADMIN.md) left
-- batches with two rows each. The pay step now writes the row itself, in
-- the same transaction that marks the batch paid
-- (apps/settlement/internal/disbursement), and relies on this constraint
-- for ON CONFLICT DO NOTHING.
--
-- Safe on a populated database: the table is locked against concurrent
-- inserts, every batch keeps its earliest row, and later duplicates are
-- moved, not dropped, into settlement_payout_disbursement_duplicates so
-- finance can reconcile any second instruction that went out.
LOCK TABLE settlement_payout_disbursements IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE settlement_payout_disbursement_duplicates (
    LIKE settlement_payout_disbursements,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY settlement_batch_id ORDER BY created_at, id) AS rn
      FROM settlement_payout_disbursements
), moved AS (
    DELETE FROM settlement_payout_disbursements d
     USING ranked r
     WHERE d.id = r.id AND r.rn > 1
    RETURNING d.id, d.settlement_batch_id, d.amount_fils, d.disbursement_reference, d.created_at
)
INSERT INTO settlement_payout_disbursement_duplicates
    (id, settlement_batch_id, amount_fils, disbursement_reference, created_at)
SELECT id, settlement_batch_id, amount_fils, disbursement_reference, created_at FROM moved;

ALTER TABLE settlement_payout_disbursements
    ADD CONSTRAINT uq_settlement_payout_disbursements_batch UNIQUE (settlement_batch_id);

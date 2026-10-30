-- Refunds now settle: CloseBatch claims each unbatched succeeded refund
-- (refunds.settlement_batch_id, 0042) and deducts amount_fils minus
-- fee_reversed_fils from the batch's net payout. A day whose refunds exceed
-- its captures closes with a negative net_payout_fils (the column has never
-- had a >= 0 CHECK; payouts and disbursements already skip net <= 0). Nothing
-- is paid for it, and the shortfall is carried into the merchant's next
-- batch close, which deducts it.
--
-- carried_forward_to_batch_id marks a negative, paid batch whose shortfall
-- has been deducted by a later batch, exactly the way settlement_batch_id
-- marks a claimed event or refund: NULL until claimed, set once, in the same
-- transaction that freezes the claiming batch's totals, so a shortfall is
-- deducted once and never twice. Nullable with no default: existing rows
-- need no backfill (no batch could be negative before refunds settled).

ALTER TABLE settlement_batches
    ADD COLUMN carried_forward_to_batch_id UUID REFERENCES settlement_batches (id);

-- Journaled money corrections settle. An admin credit (credits.ts, legs
-- against merchant_credit_contra) and a journaled balance adjustment
-- (ledgerAdjustments.ts: CSV import and adjustMerchantBalanceJournaled, legs
-- against manual_balance_adjustment_contra) move merchant_payable with no
-- transaction and no settlement batch. CloseBatch only ever read capture
-- events and refunds, so these corrections were booked as owed to (or by)
-- the merchant and never paid or collected: merchant_payable kept them for
-- good. ADR-0006 keeps cache-only display corrections out of settlement; a
-- journaled correction is real money and has to reach a payout.
--
-- ledger_entries is append-only (0092), so a claim cannot be stamped on the
-- legs themselves the way settlement_batch_id marks an event or a refund.
-- This table records it instead: one row per claimed entry group, written in
-- the same transaction that freezes the claiming batch's totals. The primary
-- key makes a group claimable by exactly one batch.
--
-- New table only: safe on a populated database. Corrections posted before
-- this migration are still owed, so the next close of each merchant claims
-- them.

CREATE TABLE settlement_batch_corrections (
    entry_group_id      UUID PRIMARY KEY,
    settlement_batch_id UUID NOT NULL REFERENCES settlement_batches (id),
    merchant_id         UUID NOT NULL REFERENCES merchants (id),
    -- Signed merchant_payable effect of the group (credits - debits).
    net_fils            BIGINT NOT NULL,
    claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_settlement_batch_corrections_batch
    ON settlement_batch_corrections (settlement_batch_id);

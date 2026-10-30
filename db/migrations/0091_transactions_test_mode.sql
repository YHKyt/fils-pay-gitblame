-- Test-mode merchants' transactions never settle (0002). Settlement used to
-- read that from merchants.test_mode at batch close, i.e. from the
-- merchant's mode at close time rather than when the money moved: a sandbox
-- capture made on day D was settled and paid out for real if the merchant
-- went live before D's batch closed (the daemon re-runs "yesterday" on every
-- tick), and with refunds now settling, a sandbox refund would be deducted
-- from the first live payout.
--
-- transactions.test_mode records the mode per transaction, at authorization:
-- a BEFORE INSERT trigger copies merchants.test_mode onto the new row, so
-- every insert path (authorize, payment links, seeds) gets it without an
-- application change. CloseBatch skips the capture events and refunds of a
-- test-mode transaction for good.
--
-- Safe on a populated database: ADD COLUMN with a constant default is a
-- metadata-only change; the backfill touches only the transactions of
-- merchants that are in test mode now, which never settled under the old
-- rule either, so no live merchant's settlement changes. A transaction made
-- in test mode by a merchant that is already live cannot be identified after
-- the fact and stays false (the old behaviour).

ALTER TABLE transactions
    ADD COLUMN test_mode BOOLEAN NOT NULL DEFAULT false;

UPDATE transactions t
   SET test_mode = true
  FROM merchants m
 WHERE m.id = t.merchant_id
   AND m.test_mode;

CREATE FUNCTION transactions_stamp_test_mode() RETURNS TRIGGER AS $$
BEGIN
    NEW.test_mode := NEW.test_mode
        OR COALESCE((SELECT m.test_mode FROM merchants m WHERE m.id = NEW.merchant_id), false);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_stamp_test_mode
    BEFORE INSERT ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_stamp_test_mode();

-- merchants.mdr_bps (0002) had no CHECK, unlike fee_schedules.mdr_bps
-- (0048, CHECK (mdr_bps >= 0)). A negative default rate was stored as is;
-- the fee paths clamp it to 0, so a mistyped -250 silently charged no MDR.
--
-- NOT VALID enforces the rule on every new INSERT/UPDATE without failing the
-- deploy on a database that already holds a negative row. Existing rows are
-- validated only when none is negative; otherwise they are left for finance
-- to correct (no rate is changed here) and VALIDATE can be run afterwards.
ALTER TABLE merchants
    ADD CONSTRAINT merchants_mdr_bps_nonnegative CHECK (mdr_bps >= 0) NOT VALID;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM merchants WHERE mdr_bps < 0) THEN
        ALTER TABLE merchants VALIDATE CONSTRAINT merchants_mdr_bps_nonnegative;
    END IF;
END
$$;

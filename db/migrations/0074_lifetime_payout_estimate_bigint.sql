-- merchants.lifetime_net_payout_monitoring_estimate was added as REAL (0040):
-- a 32-bit float holding money, against ADR-0001 (integer fils only). REAL
-- keeps ~7 significant digits, so for high-volume merchants each new payout
-- added to a large running total rounded away and the estimate drifted.
-- Store exact integer fils. Existing values are already approximate; round
-- them to the nearest fil so the column can be converted.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;
